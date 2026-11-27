use super::{FiredNotification, TaskService};
use crate::codec::decode_task_note;
use crate::error::{AppError, AppResult};
use crate::models::Task;
use crate::provider::NotebookProvider;
use crate::recurrence::{effective_current_key, generate_occurrences, schedule_for_occurrence};
use crate::reminder::{compute_fire_time_utc, compute_job_key, ComputedReminderJob};
use crate::storage::{DueReminderJob, NotificationRecord};
use chrono::{Duration, Utc};

impl<P: NotebookProvider> TaskService<P> {
    /// Materialize reminder jobs for the next 48 hours for a single task.
    pub fn reconcile_reminders(&self, task: &Task) -> AppResult<()> {
        if task.status.is_done() || task.reminders.is_empty() {
            return self.storage.reconcile_task_jobs(task.id, &[]);
        }
        let settings = self.storage.load_settings()?;
        let now = Utc::now();
        let window_end = now + Duration::hours(48);
        let today = self.today_in_tz(&task.schedule.timezone);

        let targets: Vec<(String, crate::models::Schedule)> =
            if let (Some(rule), Some(series)) = (&task.repeat, &task.series) {
                let mut v = Vec::new();
                if let Some(cur) = effective_current_key(rule, series, &today)? {
                    v.push((
                        cur.clone(),
                        schedule_for_occurrence(&task.schedule, series, &cur),
                    ));
                    for next_k in generate_occurrences(rule, 3, Some(&cur))? {
                        v.push((
                            next_k.clone(),
                            schedule_for_occurrence(&task.schedule, series, &next_k),
                        ));
                    }
                }
                v
            } else {
                let key = task
                    .schedule
                    .due
                    .as_ref()
                    .map(|d| d.date.clone())
                    .unwrap_or_else(|| "single".into());
                vec![(key, task.schedule.clone())]
            };

        let mut jobs = Vec::new();
        for (occ_key, sched) in targets {
            for rem in &task.reminders {
                if let Some(fire_utc) =
                    compute_fire_time_utc(rem, &sched, &settings.default_all_day_reminder_time)
                {
                    if fire_utc <= window_end {
                        let job_key = compute_job_key(task.id, &occ_key, rem.id(), fire_utc);
                        let due_desc = sched
                            .due
                            .as_ref()
                            .map(|d| match &d.time {
                                Some(tm) => format!("{} {} 截止", d.date, tm),
                                None => format!("{} 截止", d.date),
                            })
                            .unwrap_or_default();
                        jobs.push(ComputedReminderJob {
                            job_key,
                            task_id: task.id,
                            occurrence_key: occ_key.clone(),
                            reminder_id: rem.id().to_string(),
                            fire_at_utc: fire_utc,
                            title: format!("⏰ {}", task.title),
                            body: format!("{due_desc} · {}", rem.label_zh()),
                        });
                    }
                }
            }
        }
        self.storage.reconcile_task_jobs(task.id, &jobs)
    }

    /// Claim due reminder jobs, re-verify against NAS, record notifications, and return items to display.
    pub async fn process_due_reminders(&self) -> AppResult<Vec<FiredNotification>> {
        let now_unix = Utc::now().timestamp();
        let due_jobs: Vec<DueReminderJob> = self.storage.claim_due_jobs(now_unix)?;
        let mut fired = Vec::new();

        for job in due_jobs {
            // Re-verify against NAS before firing (DESIGN §6.1).
            let still_valid = match self.provider.get_note(job.task_id).await {
                Ok(raw) => {
                    let dec = decode_task_note(
                        raw.id,
                        &raw.title,
                        &raw.body,
                        raw.pin_flag != 0,
                        raw.updated_at,
                    );
                    if dec.task.status.is_done() {
                        false
                    } else if let Some(series) = &dec.task.series {
                        !series.history.iter().any(|h| h.key == job.occurrence_key)
                    } else {
                        true
                    }
                }
                Err(AppError::TaskNotFound(_)) => false,
                Err(_) => true, // Offline: still notify using cached job rather than dropping silently.
            };

            if !still_valid {
                self.storage.mark_job_status(&job.job_key, "cancelled")?;
                continue;
            }

            let late = (now_unix - job.fire_at_unix) > 120;
            let body = if late {
                format!("（补提醒）{}", job.body)
            } else {
                job.body.clone()
            };

            self.storage.record_notification(
                &job.job_key,
                job.task_id,
                &job.occurrence_key,
                &job.title,
                &body,
                late,
            )?;
            self.storage.mark_job_status(&job.job_key, "sent")?;

            fired.push(FiredNotification {
                job_key: job.job_key,
                task_id: job.task_id,
                occurrence_key: job.occurrence_key,
                title: job.title,
                body,
                late,
            });
        }

        Ok(fired)
    }

    pub fn list_notifications(&self, limit: u32) -> AppResult<Vec<NotificationRecord>> {
        self.storage.list_notifications(limit)
    }

    pub fn mark_notification_read(&self, id: i64) -> AppResult<()> {
        self.storage.mark_notification_read(id)
    }

    pub fn snooze_reminder(
        &self,
        task_id: i64,
        occurrence_key: &str,
        minutes: i64,
        title: &str,
        body: &str,
    ) -> AppResult<String> {
        let fire_at = Utc::now() + Duration::minutes(minutes.max(1));
        self.storage
            .add_snooze_job(task_id, occurrence_key, fire_at, title, body)
    }

    /// Re-materialize 48h reminders for all cached active tasks without touching NAS (offline safety).
    pub fn reconcile_all_cached_reminders(&self) -> AppResult<usize> {
        let tasks = self.storage.list_cached_tasks()?;
        let mut count = 0usize;
        for t in tasks {
            if !t.status.is_done() && !t.reminders.is_empty() {
                self.reconcile_reminders(&t)?;
                count += 1;
            }
        }
        Ok(count)
    }
}
