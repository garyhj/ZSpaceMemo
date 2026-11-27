use super::{ComputedDueInfo, TaskService};
use crate::error::AppResult;
use crate::models::{CalendarTaskItem, OccurrenceActionStatus, Task, TaskSort, TaskView};
use crate::provider::NotebookProvider;
use crate::recurrence::{
    effective_current_key, format_date, generate_occurrences, parse_date, schedule_for_occurrence,
};
use crate::reminder::resolve_local_to_utc;
use chrono::{DateTime, Duration, NaiveTime, Utc};
use chrono_tz::Tz;

impl<P: NotebookProvider> TaskService<P> {
    pub(super) fn compute_due_and_overdue(
        &self,
        task: &Task,
        fallback_tz: Tz,
        now_utc: DateTime<Utc>,
    ) -> ComputedDueInfo {
        let task_tz: Tz = task.schedule.timezone.parse().unwrap_or(fallback_tz);
        let today_in_task_tz = format_date(now_utc.with_timezone(&task_tz).date_naive());

        let (eff_key, due) = if let (Some(rule), Some(series)) = (&task.repeat, &task.series) {
            let key = effective_current_key(rule, series, &today_in_task_tz)
                .ok()
                .flatten();
            let due = key.as_deref().and_then(|k| {
                let s = schedule_for_occurrence(&task.schedule, series, k);
                let d = s.due?;
                Some((d.date, d.time, s.all_day))
            });
            (key, due)
        } else {
            let due = task
                .schedule
                .due
                .as_ref()
                .map(|d| (d.date.clone(), d.time.clone(), task.schedule.all_day));
            (None, due)
        };

        let overdue = if task.status.is_done() {
            false
        } else if let Some((ref date, ref time, all_day)) = due {
            if !all_day {
                if let Some(tm) = time {
                    if let (Ok(d), Ok(t)) = (
                        parse_date(date),
                        NaiveTime::parse_from_str(tm, "%H:%M")
                            .or_else(|_| NaiveTime::parse_from_str(tm, "%H:%M:%S")),
                    ) {
                        let due_utc = resolve_local_to_utc(d.and_time(t), task_tz);
                        due_utc < now_utc
                    } else {
                        date.as_str() < today_in_task_tz.as_str()
                    }
                } else {
                    date.as_str() < today_in_task_tz.as_str()
                }
            } else {
                date.as_str() < today_in_task_tz.as_str()
            }
        } else {
            false
        };

        ComputedDueInfo {
            eff_key,
            due,
            overdue,
            today_tz: today_in_task_tz,
        }
    }

    pub(super) fn enrich_task_view_with_tz(
        &self,
        mut task: Task,
        fallback_tz: Tz,
        now_utc: DateTime<Utc>,
    ) -> Task {
        let info = self.compute_due_and_overdue(&task, fallback_tz, now_utc);
        task.effective_current_key = info.eff_key;
        task.is_overdue = Some(info.overdue);
        task
    }

    pub(super) fn enrich_task_view(&self, task: Task) -> Task {
        let fallback_tz: Tz = self
            .storage
            .load_settings()
            .ok()
            .and_then(|s| s.timezone.parse().ok())
            .unwrap_or(chrono_tz::Asia::Shanghai);
        self.enrich_task_view_with_tz(task, fallback_tz, Utc::now())
    }

    pub(super) fn today_in_tz(&self, tz_name: &str) -> String {
        let tz: Tz = tz_name.parse().unwrap_or(chrono_tz::Asia::Shanghai);
        format_date(Utc::now().with_timezone(&tz).date_naive())
    }

    /// Build occurrence timeline for UI display using the task's configured IANA timezone.
    pub async fn get_occurrence_timeline(
        &self,
        id: i64,
        future_count: usize,
    ) -> AppResult<Vec<crate::models::OccurrenceView>> {
        let task = self.get_task(id, false).await?;
        let (Some(rule), Some(series)) = (&task.repeat, &task.series) else {
            return Ok(Vec::new());
        };
        let today = self.today_in_tz(&task.schedule.timezone);
        crate::recurrence::build_occurrence_timeline(
            rule,
            series,
            &task.schedule,
            &today,
            future_count,
        )
    }

    /// Expand all single tasks and repeating series occurrences falling within `[from, to]` (inclusive).
    pub fn list_calendar_items(
        &self,
        from: &str,
        to: &str,
        include_completed: bool,
    ) -> AppResult<Vec<CalendarTaskItem>> {
        let from_date = parse_date(from)?;
        let _ = parse_date(to)?;
        let after_before_from = format_date(from_date - Duration::days(1));

        let tasks = self.storage.list_cached_tasks()?;
        let mut items = Vec::new();

        for task in tasks {
            if let (Some(rule), Some(series)) = (&task.repeat, &task.series) {
                let mut keys = generate_occurrences(rule, 64, Some(&after_before_from))?;
                // Also include any overridden or historical keys that land inside [from, to].
                for (k, ov) in &series.overrides {
                    if let Some(d) = ov.schedule.as_ref().and_then(|s| s.due.as_ref()) {
                        if d.date.as_str() >= from && d.date.as_str() <= to && !keys.contains(k) {
                            keys.push(k.clone());
                        }
                    }
                }
                for h in &series.history {
                    if h.key.as_str() >= from && h.key.as_str() <= to && !keys.contains(&h.key) {
                        keys.push(h.key.clone());
                    }
                }

                for key in keys {
                    if series.ended_at.is_some() && !series.history.iter().any(|h| h.key == key) {
                        continue;
                    }
                    let sched = schedule_for_occurrence(&task.schedule, series, &key);
                    let Some(due) = sched.due else { continue };
                    if due.date.as_str() < from || due.date.as_str() > to {
                        continue;
                    }
                    let hist = series.history.iter().find(|h| h.key == key);
                    let done = hist.is_some();
                    if done && !include_completed {
                        continue;
                    }
                    items.push(CalendarTaskItem {
                        task_id: task.id,
                        title: series
                            .overrides
                            .get(&key)
                            .and_then(|o| o.title.clone())
                            .unwrap_or_else(|| task.title.clone()),
                        date: due.date,
                        time: due.time,
                        all_day: sched.all_day,
                        priority: series
                            .overrides
                            .get(&key)
                            .and_then(|o| o.priority)
                            .unwrap_or(task.priority),
                        list: task.list.clone(),
                        done,
                        is_repeating: true,
                        occurrence_key: Some(key),
                    });
                }
            } else {
                let done = task.status.is_done();
                if done && !include_completed {
                    continue;
                }
                if let Some(due) = &task.schedule.due {
                    if due.date.as_str() >= from && due.date.as_str() <= to {
                        items.push(CalendarTaskItem {
                            task_id: task.id,
                            title: task.title.clone(),
                            date: due.date.clone(),
                            time: if task.schedule.all_day {
                                None
                            } else {
                                due.time.clone()
                            },
                            all_day: task.schedule.all_day,
                            priority: task.priority,
                            list: task.list.clone(),
                            done,
                            is_repeating: false,
                            occurrence_key: None,
                        });
                    }
                }
            }
        }

        items.sort_by(|a, b| {
            a.date
                .cmp(&b.date)
                .then_with(|| a.done.cmp(&b.done))
                .then_with(|| {
                    a.time
                        .as_deref()
                        .unwrap_or("99:99")
                        .cmp(b.time.as_deref().unwrap_or("99:99"))
                })
                .then_with(|| a.priority.sort_rank().cmp(&b.priority.sort_rank()))
        });
        Ok(items)
    }

    /// Query cached tasks by view, search keyword, and sort order (DESIGN §7.1).
    pub fn list_tasks(
        &self,
        view: TaskView,
        keyword: Option<&str>,
        sort: TaskSort,
    ) -> AppResult<Vec<Task>> {
        let settings = self.storage.load_settings()?;
        let now_utc = Utc::now();
        let fallback_tz: Tz = settings
            .timezone
            .parse()
            .unwrap_or(chrono_tz::Asia::Shanghai);

        let q = keyword
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());

        let mut tasks = self.storage.list_cached_tasks()?;
        if let Some(q_str) = &q {
            tasks.retain(|t| {
                t.title.to_lowercase().contains(q_str)
                    || t.description.to_lowercase().contains(q_str)
                    || t.list
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(q_str)
                    || t.labels.iter().any(|l| l.to_lowercase().contains(q_str))
            });
        }

        let mut filtered: Vec<Task> = tasks
            .into_iter()
            .filter(|t| {
                let info = self.compute_due_and_overdue(t, fallback_tz, now_utc);
                let today_date =
                    parse_date(&info.today_tz).unwrap_or_else(|_| now_utc.date_naive());
                let upcoming_end =
                    format_date(today_date + Duration::days(settings.upcoming_days as i64));
                match view {
                    TaskView::Inbox => {
                        !t.status.is_done() && t.repeat.is_none() && t.schedule.due.is_none()
                    }
                    TaskView::Today => {
                        if t.status.is_done() {
                            return false;
                        }
                        let due_today = info
                            .due
                            .as_ref()
                            .map(|(d, _, _)| d == &info.today_tz)
                            .unwrap_or(false);
                        due_today || (settings.show_overdue_in_today && info.overdue)
                    }
                    TaskView::Upcoming => {
                        if t.status.is_done() {
                            return false;
                        }
                        info.due
                            .as_ref()
                            .map(|(d, _, _)| {
                                d.as_str() > info.today_tz.as_str()
                                    && d.as_str() <= upcoming_end.as_str()
                            })
                            .unwrap_or(false)
                    }
                    TaskView::Overdue => info.overdue,
                    TaskView::All => !t.status.is_done(),
                    TaskView::Completed => {
                        t.status.is_done()
                            || t.series
                                .as_ref()
                                .map(|s| {
                                    s.history
                                        .iter()
                                        .any(|h| h.status == OccurrenceActionStatus::Completed)
                                })
                                .unwrap_or(false)
                    }
                    TaskView::Repeating => t.repeat.is_some(),
                }
            })
            .map(|t| self.enrich_task_view_with_tz(t, fallback_tz, now_utc))
            .collect();

        filtered.sort_by(|a, b| {
            // Pinned items first in active views.
            if view != TaskView::Completed {
                let pin_cmp = b.pinned.cmp(&a.pinned);
                if pin_cmp != std::cmp::Ordering::Equal {
                    return pin_cmp;
                }
            }
            match sort {
                TaskSort::Priority => a
                    .priority
                    .sort_rank()
                    .cmp(&b.priority.sort_rank())
                    .then_with(|| a.id.cmp(&b.id)),
                TaskSort::Created => b.created_at.cmp(&a.created_at),
                TaskSort::Date => {
                    let key_of = |t: &Task| -> String {
                        let info = self.compute_due_and_overdue(t, fallback_tz, now_utc);
                        info.due
                            .map(|(d, tm, _)| {
                                format!("{d} {}", tm.unwrap_or_else(|| "99:99".into()))
                            })
                            .unwrap_or_else(|| "9999-99-99 99:99".into())
                    };
                    key_of(a)
                        .cmp(&key_of(b))
                        .then_with(|| a.priority.sort_rank().cmp(&b.priority.sort_rank()))
                }
            }
        });

        Ok(filtered)
    }
}
