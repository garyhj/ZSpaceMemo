use crate::codec::{decode_task_note, encode_task_note};
use crate::error::{AppError, AppResult};
use crate::models::{
    CalendarTaskItem, CreateTaskInput, DateTimePoint, HistorySummary, MetaState,
    OccurrenceActionStatus, OccurrenceHistoryEntry, OccurrenceOverride, Schedule, SeriesState,
    Task, TaskSort, TaskStatus, TaskView, UpdateTaskInput,
};
use crate::provider::NotebookProvider;
use crate::recurrence::{
    effective_current_key, format_date, generate_occurrences, next_after_action, parse_date,
    schedule_for_occurrence,
};
use crate::reminder::{compute_fire_time_utc, compute_job_key, ComputedReminderJob};
use crate::storage::{AppSettings, DueReminderJob, LocalStorage, NotificationRecord};
use chrono::{Duration, NaiveDateTime, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;
use tracing::{info, warn};

const MAX_HISTORY_ENTRIES: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct SyncSummary {
    pub total_notes: usize,
    pub fetched_details: usize,
    pub recovered_count: usize,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FiredNotification {
    pub job_key: String,
    pub task_id: i64,
    pub occurrence_key: String,
    pub title: String,
    pub body: String,
    pub late: bool,
}

pub struct TaskService<P: NotebookProvider> {
    provider: Arc<P>,
    storage: Arc<LocalStorage>,
}

impl<P: NotebookProvider> TaskService<P> {
    pub fn new(provider: Arc<P>, storage: Arc<LocalStorage>) -> Self {
        Self { provider, storage }
    }

    pub fn storage(&self) -> &LocalStorage {
        &self.storage
    }

    pub fn provider(&self) -> &P {
        &self.provider
    }

    pub fn get_settings(&self) -> AppResult<AppSettings> {
        self.storage.load_settings()
    }

    pub fn save_settings(&self, settings: &AppSettings) -> AppResult<()> {
        let normalized = settings.normalized_and_validated()?;
        self.storage.save_settings(&normalized)
    }

    /// Resolve or initialize the dedicated Todo category (never duplicates if renamed by user).
    pub async fn initialize_todo_category(&self, create_if_missing: bool) -> AppResult<i64> {
        let mut settings = self.storage.load_settings()?;
        let categories = self.provider.list_categories().await?;

        // 1. Check by saved ID first (handles user renaming in official app).
        if let Some(saved_id) = settings.todo_category_id {
            if let Some(cat) = categories.iter().find(|c| c.id == saved_id) {
                if cat.name != settings.todo_category_name {
                    settings.todo_category_name = cat.name.clone();
                    self.storage.save_settings(&settings)?;
                }
                return Ok(saved_id);
            }
            return Err(AppError::CategoryNotConfigured(format!(
                "已保存的分类 ID={saved_id} 在极空间中已不存在，请在设置中重新初始化"
            )));
        }

        // 2. Match by configured name.
        if let Some(cat) = categories
            .iter()
            .find(|c| c.name == settings.todo_category_name)
        {
            settings.todo_category_id = Some(cat.id);
            self.storage.save_settings(&settings)?;
            return Ok(cat.id);
        }

        // 3. Optionally create dedicated top-level category.
        if !create_if_missing {
            return Err(AppError::CategoryNotConfigured(format!(
                "未找到专用分类「{}」，请先初始化",
                settings.todo_category_name
            )));
        }
        let new_id = self
            .provider
            .create_category(&settings.todo_category_name)
            .await?;
        settings.todo_category_id = Some(new_id);
        self.storage.save_settings(&settings)?;
        info!(category_id = new_id, name = %settings.todo_category_name, "created todo category");
        Ok(new_id)
    }

    fn require_category_id(&self) -> AppResult<i64> {
        self.storage
            .load_settings()?
            .todo_category_id
            .ok_or_else(|| AppError::CategoryNotConfigured("尚未初始化 ZSpace Memo 专用分类".into()))
    }

    /// Incremental sync from NAS into local SQLite index cache + reminder job reconciliation.
    pub async fn sync(&self) -> AppResult<SyncSummary> {
        let cat_id = self.initialize_todo_category(false).await?;
        let mut all_summaries = Vec::new();
        let mut start = 0u32;
        const PAGE: u32 = 50;

        loop {
            let batch = self.provider.list_notes(cat_id, start, PAGE).await?;
            let count = batch.len();
            all_summaries.extend(batch);
            if count < PAGE as usize {
                break;
            }
            start += PAGE;
        }

        let keep_ids: Vec<i64> = all_summaries.iter().map(|s| s.id).collect();
        let mut fetched_details = 0usize;
        let mut recovered_count = 0usize;

        for summary in &all_summaries {
            let cached = self.storage.get_cached_task(summary.id)?;
            let unchanged = cached.as_ref().map_or(false, |c| {
                c.updated_at_unix == summary.updated_at
                    && c.length == summary.length
                    && c.task.title == summary.title
                    && c.task.pinned == (summary.pin_flag != 0)
            });

            if unchanged {
                if let Some(c) = cached {
                    self.reconcile_reminders(&c.task)?;
                }
                continue;
            }

            let raw = self.provider.get_note(summary.id).await?;
            fetched_details += 1;
            let mut decoded = decode_task_note(
                raw.id,
                &raw.title,
                &raw.body,
                raw.pin_flag != 0,
                raw.updated_at,
            );

            if decoded.meta_corrupted {
                if let Some(recovered) = self
                    .try_recover_metadata(&decoded.task, cached.as_ref())
                    .await?
                {
                    decoded.task = recovered;
                    decoded.meta_present = true;
                    decoded.meta_corrupted = false;
                    recovered_count += 1;
                    // Write recovered metadata back to NAS while keeping user's new title & description.
                    let enc = encode_task_note(&decoded.task);
                    let _ = self
                        .provider
                        .update_note(raw.id, &enc.title, &enc.body, &enc.in_brief)
                        .await;
                    decoded.task.etag = enc.etag;
                }
            }

            self.storage.upsert_cached_task(
                &decoded.task,
                raw.updated_at,
                raw.length,
                decoded.meta_present && !decoded.meta_corrupted,
            )?;

            // Only reconcile reminders when metadata is valid; if corrupted & unrecovered,
            // keep existing reminder jobs intact per DESIGN §4.3.
            if !decoded.meta_corrupted {
                self.reconcile_reminders(&decoded.task)?;
            }
        }

        self.storage.remove_cached_tasks_except(&keep_ids)?;

        Ok(SyncSummary {
            total_notes: all_summaries.len(),
            fetched_details,
            recovered_count,
            synced_at: Utc::now().to_rfc3339(),
        })
    }

    async fn try_recover_metadata(
        &self,
        edited: &Task,
        cached: Option<&crate::storage::CachedTaskRow>,
    ) -> AppResult<Option<Task>> {
        // 1. Primary recovery: last valid metadata from local SQLite cache.
        if let Some(row) = cached {
            if let Some(json) = &row.last_valid_task_json {
                if let Ok(mut prev) = serde_json::from_str::<Task>(json) {
                    prev.title = edited.title.clone();
                    prev.description = edited.description.clone();
                    prev.rich_body_protected = edited.rich_body_protected;
                    prev.raw_description_html = edited.raw_description_html.clone();
                    prev.pinned = edited.pinned;
                    prev.updated_at = edited.updated_at.clone();
                    prev.rev += 1;
                    prev.meta_state = MetaState::Recovered;
                    warn!(task_id = edited.id, "recovered corrupted metadata from local cache");
                    return Ok(Some(prev));
                }
            }
        }

        // 2. Secondary recovery: NAS version history.
        if let Ok(hist) = self.provider.list_history(edited.id).await {
            for h in hist {
                if let Some(body) = h.body {
                    let dec = decode_task_note(edited.id, &edited.title, &body, edited.pinned, 0);
                    if dec.meta_present && !dec.meta_corrupted {
                        let mut prev = dec.task;
                        prev.title = edited.title.clone();
                        prev.description = edited.description.clone();
                        prev.rich_body_protected = edited.rich_body_protected;
                        prev.raw_description_html = edited.raw_description_html.clone();
                        prev.rev += 1;
                        prev.meta_state = MetaState::Recovered;
                        warn!(task_id = edited.id, "recovered corrupted metadata from NAS history");
                        return Ok(Some(prev));
                    }
                }
            }
        }

        Ok(None)
    }

    /// Create a new task on NAS, read it back to verify persistence, update cache & reminders.
    pub async fn create_task(&self, input: CreateTaskInput) -> AppResult<Task> {
        let title = input.title.trim().to_string();
        if title.is_empty() {
            return Err(AppError::Validation("任务标题不能为空".into()));
        }
        let cat_id = self.require_category_id()?;
        let now_iso = Utc::now().to_rfc3339();

        let (status, series) = if let Some(rule) = &input.repeat {
            let first = generate_occurrences(rule, 1, None)?
                .into_iter()
                .next()
                .unwrap_or_else(|| rule.dtstart.clone());
            (
                TaskStatus::Active,
                Some(SeriesState {
                    cursor: first,
                    overrides: BTreeMap::new(),
                    history: Vec::new(),
                    history_summary: None,
                    ended_at: None,
                }),
            )
        } else {
            (TaskStatus::Pending, None)
        };

        let mut task = Task {
            id: 0,
            title: title.clone(),
            description: input.description,
            rich_body_protected: false,
            raw_description_html: None,
            status,
            priority: input.priority,
            list: input.list.filter(|s| !s.trim().is_empty()),
            labels: input.labels,
            pinned: input.pinned,
            schedule: input.schedule,
            reminders: input.reminders,
            repeat: input.repeat,
            series,
            completed_at: None,
            created_at: Some(now_iso),
            updated_at: None,
            source: "zspace_notebook".into(),
            meta_state: MetaState::Ok,
            rev: 1,
            etag: String::new(),
        };

        let encoded = encode_task_note(&task);
        let created_raw = self
            .provider
            .create_note(&encoded.title, &encoded.body, cat_id, &encoded.in_brief)
            .await?;

        if task.pinned {
            let _ = self.provider.pin_note(created_raw.id, true).await;
        }

        // Verify returned note directly when NAS returns full body (confirmed in M0);
        // only fall back to an extra get_note if body is empty.
        let verified = if created_raw.body.is_empty() {
            self.provider.get_note(created_raw.id).await?
        } else {
            created_raw
        };
        let decoded = decode_task_note(
            verified.id,
            &verified.title,
            &verified.body,
            task.pinned || verified.pin_flag != 0,
            verified.updated_at,
        );
        if !decoded.meta_present {
            return Err(AppError::MetaUnparseable(
                "创建笔记后校验失败：元数据未正确保存".into(),
            ));
        }

        task = decoded.task;
        self.storage
            .upsert_cached_task(&task, verified.updated_at, verified.length, true)?;
        self.reconcile_reminders(&task)?;
        Ok(task)
    }

    pub async fn get_task(&self, id: i64, refresh: bool) -> AppResult<Task> {
        if !refresh {
            if let Some(c) = self.storage.get_cached_task(id)? {
                return Ok(c.task);
            }
        }
        let raw = self.provider.get_note(id).await?;
        let decoded = decode_task_note(raw.id, &raw.title, &raw.body, raw.pin_flag != 0, raw.updated_at);
        self.storage.upsert_cached_task(
            &decoded.task,
            raw.updated_at,
            raw.length,
            decoded.meta_present && !decoded.meta_corrupted,
        )?;
        Ok(decoded.task)
    }

    /// Update a task with optimistic concurrency check (ETag).
    pub async fn update_task(&self, id: i64, patch: UpdateTaskInput) -> AppResult<Task> {
        let latest_raw = self.provider.get_note(id).await?;
        let decoded = decode_task_note(
            latest_raw.id,
            &latest_raw.title,
            &latest_raw.body,
            latest_raw.pin_flag != 0,
            latest_raw.updated_at,
        );
        let mut task = decoded.task;

        if !patch.force {
            if let Some(expected) = &patch.etag {
                if !expected.is_empty() && expected != &task.etag {
                    return Err(AppError::TaskConflict {
                        task_id: id,
                        expected_etag: expected.clone(),
                        actual_etag: task.etag.clone(),
                    });
                }
            }
        }

        if let Some(title) = patch.title {
            let t = title.trim().to_string();
            if t.is_empty() {
                return Err(AppError::Validation("任务标题不能为空".into()));
            }
            task.title = t;
        }
        if let Some(desc) = patch.description {
            if !task.rich_body_protected {
                task.description = desc;
            }
        }
        if let Some(st) = patch.status {
            task.status = st;
            if st == TaskStatus::Completed && task.completed_at.is_none() {
                task.completed_at = Some(Utc::now().to_rfc3339());
            } else if st == TaskStatus::Pending {
                task.completed_at = None;
            }
        }
        if let Some(pri) = patch.priority {
            task.priority = pri;
        }
        if let Some(list_opt) = patch.list {
            task.list = list_opt.filter(|s| !s.trim().is_empty());
        }
        if let Some(labels) = patch.labels {
            task.labels = labels;
        }
        if let Some(sched) = patch.schedule {
            task.schedule = sched;
        }
        if let Some(reminders) = patch.reminders {
            task.reminders = reminders;
        }
        if let Some(repeat_opt) = patch.repeat {
            match repeat_opt {
                Some(rule) => {
                    let cur = generate_occurrences(&rule, 1, None)?
                        .into_iter()
                        .next()
                        .unwrap_or_else(|| rule.dtstart.clone());
                    if task.series.is_none() {
                        task.series = Some(SeriesState {
                            cursor: cur,
                            overrides: BTreeMap::new(),
                            history: Vec::new(),
                            history_summary: None,
                            ended_at: None,
                        });
                    }
                    task.status = TaskStatus::Active;
                    task.repeat = Some(rule);
                }
                None => {
                    task.repeat = None;
                    task.series = None;
                    if task.status == TaskStatus::Active {
                        task.status = TaskStatus::Pending;
                    }
                }
            }
        }

        let pin_changed = patch.pinned.map(|p| (p, p != task.pinned));
        if let Some((new_pin, _)) = pin_changed {
            task.pinned = new_pin;
        }

        self.persist_task_update(task, pin_changed.and_then(|(p, changed)| changed.then_some(p)))
            .await
    }

    async fn persist_task_update(&self, mut task: Task, pin_update: Option<bool>) -> AppResult<Task> {
        task.rev = task.rev.saturating_add(1);
        task.meta_state = MetaState::Ok;
        let encoded = encode_task_note(&task);

        self.provider
            .update_note(task.id, &encoded.title, &encoded.body, &encoded.in_brief)
            .await?;
        if let Some(p) = pin_update {
            self.provider.pin_note(task.id, p).await?;
        }

        let now = Utc::now();
        task.etag = encoded.etag;
        task.updated_at = Some(now.to_rfc3339());
        self.storage.upsert_cached_task(
            &task,
            now.timestamp(),
            encoded.body.len() as i64,
            true,
        )?;
        self.reconcile_reminders(&task)?;
        Ok(task)
    }

    /// Idempotent complete/skip for a single task or a repeating occurrence.
    pub async fn act_on_occurrence(
        &self,
        id: i64,
        occurrence_key: Option<&str>,
        action: OccurrenceActionStatus,
    ) -> AppResult<Task> {
        let mut task = self.get_task(id, false).await?;
        let now = Utc::now();
        let now_iso = now.to_rfc3339();
        let today = self.today_in_tz(&task.schedule.timezone);

        if let (Some(rule), Some(series)) = (&task.repeat, &mut task.series) {
            let key = match occurrence_key {
                Some(k) => k.to_string(),
                None => effective_current_key(rule, series, &today)?
                    .ok_or_else(|| AppError::OccurrenceNotFound("系列已结束".into()))?,
            };
            // Idempotency: if this occurrence key is already recorded, return as-is.
            if series.history.iter().any(|h| h.key == key) {
                return Ok(task);
            }
            series.history.insert(
                0,
                OccurrenceHistoryEntry {
                    key: key.clone(),
                    status: action,
                    at: now_iso.clone(),
                },
            );
            series.overrides.remove(&key);

            // Cap history size at MAX_HISTORY_ENTRIES, folding older entries into history_summary.
            if series.history.len() > MAX_HISTORY_ENTRIES {
                let overflow = series.history.split_off(MAX_HISTORY_ENTRIES);
                let summary = series
                    .history_summary
                    .get_or_insert_with(HistorySummary::default);
                for old in overflow {
                    match old.status {
                        OccurrenceActionStatus::Completed => summary.completed += 1,
                        OccurrenceActionStatus::Skipped => summary.skipped += 1,
                    }
                    summary.before = Some(old.key);
                }
            }

            let today_date = parse_date(&today).unwrap_or_else(|_| now.date_naive());
            match next_after_action(rule, &key, today_date)? {
                Some(next_key) => {
                    series.cursor = next_key;
                }
                None => {
                    series.ended_at = Some(now_iso);
                    task.status = TaskStatus::Ended;
                }
            }
            return self.persist_task_update(task, None).await;
        }

        // Single task.
        task.status = TaskStatus::Completed;
        task.completed_at = Some(now_iso);
        self.persist_task_update(task, None).await
    }

    pub async fn reopen_task(&self, id: i64, occurrence_key: Option<&str>) -> AppResult<Task> {
        let mut task = self.get_task(id, false).await?;
        if let (Some(_rule), Some(series)) = (&task.repeat, &mut task.series) {
            if let Some(key) = occurrence_key {
                series.history.retain(|h| h.key != key);
                if key < series.cursor.as_str() {
                    series.cursor = key.to_string();
                }
                series.ended_at = None;
                task.status = TaskStatus::Active;
            }
        } else {
            task.status = TaskStatus::Pending;
            task.completed_at = None;
        }
        self.persist_task_update(task, None).await
    }

    pub async fn end_series(&self, id: i64) -> AppResult<Task> {
        let mut task = self.get_task(id, false).await?;
        if let Some(series) = &mut task.series {
            series.ended_at = Some(Utc::now().to_rfc3339());
            task.status = TaskStatus::Ended;
        }
        self.persist_task_update(task, None).await
    }

    pub async fn delete_task(&self, id: i64) -> AppResult<()> {
        self.provider.delete_note(id).await?;
        self.storage.delete_cached_task(id)?;
        Ok(())
    }

    /// Override a single occurrence's due date/time without modifying the rest of the repeating series.
    pub async fn override_occurrence(
        &self,
        id: i64,
        occurrence_key: &str,
        new_due_date: &str,
        new_due_time: Option<&str>,
    ) -> AppResult<Task> {
        self.override_occurrence_detail(id, occurrence_key, new_due_date, new_due_time, None, None)
            .await
    }

    /// Override a single occurrence's due date/time/all_day or title without modifying the series template.
    pub async fn override_occurrence_detail(
        &self,
        id: i64,
        occurrence_key: &str,
        new_due_date: &str,
        new_due_time: Option<&str>,
        new_all_day: Option<bool>,
        new_title: Option<&str>,
    ) -> AppResult<Task> {
        let _ = parse_date(new_due_date)?;
        let mut task = self.get_task(id, false).await?;
        if let Some(series) = &mut task.series {
            let entry = series
                .overrides
                .entry(occurrence_key.to_string())
                .or_insert_with(OccurrenceOverride::default);
            if let Some(title) = new_title.map(str::trim).filter(|s| !s.is_empty()) {
                entry.title = Some(title.to_string());
            }
            let prev_sched = entry.schedule.as_ref();
            let resolved_all_day = match new_all_day {
                Some(ad) => ad,
                None => match new_due_time {
                    Some(_) => false,
                    None => prev_sched.map(|s| s.all_day).unwrap_or(task.schedule.all_day),
                },
            };
            let resolved_time = if resolved_all_day {
                None
            } else {
                new_due_time
                    .map(|s| s.to_string())
                    .or_else(|| prev_sched.and_then(|s| s.due.as_ref()?.time.clone()))
                    .or_else(|| task.schedule.due.as_ref().and_then(|d| d.time.clone()))
            };
            entry.schedule = Some(Schedule {
                all_day: resolved_all_day,
                due: Some(DateTimePoint {
                    date: new_due_date.to_string(),
                    time: resolved_time,
                }),
                timezone: task.schedule.timezone.clone(),
            });
            return self.persist_task_update(task, None).await;
        }
        // Fallback for non-repeating task: update due date directly.
        let resolved_all_day = new_all_day.unwrap_or_else(|| task.schedule.all_day && new_due_time.is_none());
        task.schedule.all_day = resolved_all_day;
        task.schedule.due = Some(DateTimePoint {
            date: new_due_date.to_string(),
            time: if resolved_all_day {
                None
            } else {
                new_due_time
                    .map(|s| s.to_string())
                    .or_else(|| task.schedule.due.as_ref().and_then(|d| d.time.clone()))
            },
        });
        self.persist_task_update(task, None).await
    }

    /// Remove a single occurrence override so it falls back to the series template schedule.
    pub async fn clear_occurrence_override(
        &self,
        id: i64,
        occurrence_key: &str,
    ) -> AppResult<Task> {
        let mut task = self.get_task(id, false).await?;
        if let Some(series) = &mut task.series {
            if series.overrides.remove(occurrence_key).is_some() {
                return self.persist_task_update(task, None).await;
            }
        }
        Ok(task)
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
        crate::recurrence::build_occurrence_timeline(rule, series, &task.schedule, &today, future_count)
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

    fn today_in_tz(&self, tz_name: &str) -> String {
        let tz: Tz = tz_name.parse().unwrap_or(chrono_tz::Asia::Shanghai);
        format_date(Utc::now().with_timezone(&tz).date_naive())
    }

    /// Query cached tasks by view, search keyword, and sort order (DESIGN §7.1).
    pub fn list_tasks(
        &self,
        view: TaskView,
        keyword: Option<&str>,
        sort: TaskSort,
    ) -> AppResult<Vec<Task>> {
        let settings = self.storage.load_settings()?;
        let today = self.today_in_tz(&settings.timezone);
        let today_date = parse_date(&today)?;
        let upcoming_end = format_date(today_date + Duration::days(settings.upcoming_days as i64));
        let now_utc = Utc::now();
        let tz: Tz = settings
            .timezone
            .parse()
            .unwrap_or(chrono_tz::Asia::Shanghai);
        let now_local = now_utc.with_timezone(&tz).naive_local();

        let q = keyword.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());

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

        let effective_due = |t: &Task| -> Option<(String, Option<String>, bool)> {
            if let (Some(rule), Some(series)) = (&t.repeat, &t.series) {
                let key = effective_current_key(rule, series, &today).ok().flatten()?;
                let s = schedule_for_occurrence(&t.schedule, series, &key);
                let d = s.due?;
                return Some((d.date, d.time, s.all_day));
            }
            let d = t.schedule.due.as_ref()?;
            Some((d.date.clone(), d.time.clone(), t.schedule.all_day))
        };

        let is_overdue = |t: &Task| -> bool {
            if t.status.is_done() {
                return false;
            }
            let Some((date, time, all_day)) = effective_due(t) else {
                return false;
            };
            if !all_day {
                if let Some(tm) = time {
                    if let Ok(dt) = NaiveDateTime::parse_from_str(
                        &format!("{date}T{tm}"),
                        "%Y-%m-%dT%H:%M",
                    ) {
                        return dt < now_local;
                    }
                }
            }
            date.as_str() < today.as_str()
        };

        let mut filtered: Vec<Task> = tasks
            .into_iter()
            .filter(|t| match view {
                TaskView::Inbox => {
                    !t.status.is_done() && t.repeat.is_none() && t.schedule.due.is_none()
                }
                TaskView::Today => {
                    if t.status.is_done() {
                        return false;
                    }
                    let due_today = effective_due(t)
                        .map(|(d, _, _)| d == today)
                        .unwrap_or(false);
                    due_today || (settings.show_overdue_in_today && is_overdue(t))
                }
                TaskView::Upcoming => {
                    if t.status.is_done() {
                        return false;
                    }
                    effective_due(t)
                        .map(|(d, _, _)| d > today && d <= upcoming_end)
                        .unwrap_or(false)
                }
                TaskView::Overdue => is_overdue(t),
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
            })
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
                    let ka = effective_due(a)
                        .map(|(d, t, _)| format!("{d} {}", t.unwrap_or_else(|| "99:99".into())))
                        .unwrap_or_else(|| "9999-99-99 99:99".into());
                    let kb = effective_due(b)
                        .map(|(d, t, _)| format!("{d} {}", t.unwrap_or_else(|| "99:99".into())))
                        .unwrap_or_else(|| "9999-99-99 99:99".into());
                    ka.cmp(&kb)
                        .then_with(|| a.priority.sort_rank().cmp(&b.priority.sort_rank()))
                }
            }
        });

        Ok(filtered)
    }

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
                    v.push((cur.clone(), schedule_for_occurrence(&task.schedule, series, &cur)));
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::due_point;
    use crate::models::{Priority, Reminder, RepeatFreq, RepeatRule, Schedule};
    use crate::provider::mock::MockNotebookProvider;

    async fn setup() -> (TaskService<MockNotebookProvider>, Arc<MockNotebookProvider>) {
        let provider = Arc::new(MockNotebookProvider::new());
        let storage = Arc::new(LocalStorage::open_in_memory().unwrap());
        let svc = TaskService::new(provider.clone(), storage);
        svc.initialize_todo_category(true).await.unwrap();
        (svc, provider)
    }

    #[tokio::test]
    async fn full_crud_conflict_and_auto_recovery() {
        let (svc, provider) = setup().await;

        let created = svc
            .create_task(CreateTaskInput {
                title: "续费 eSIM".into(),
                description: "核对套餐".into(),
                priority: Priority::High,
                list: Some("个人".into()),
                labels: vec!["续费".into()],
                pinned: false,
                schedule: Schedule {
                    all_day: false,
                    due: Some(due_point("2026-11-26", Some("18:00"))),
                    timezone: "Asia/Shanghai".into(),
                },
                reminders: vec![Reminder::Relative {
                    id: "r1".into(),
                    offset_minutes: Some(-60),
                    offset_days: None,
                    day_time: None,
                }],
                repeat: Some(RepeatRule {
                    freq: RepeatFreq::Monthly,
                    interval: 6,
                    calendar: Default::default(),
                    by_weekday: None,
                    by_set_pos: None,
                    by_month_day: Some(vec![26]),
                    by_month: None,
                    lunar: None,
                    day_filter: None,
                    on_invalid_date: Default::default(),
                    basis: Default::default(),
                    catch_up: Default::default(),
                    end: Default::default(),
                    dtstart: "2026-11-26".into(),
                }),
            })
            .await
            .unwrap();

        assert_eq!(created.status, TaskStatus::Active);
        assert_eq!(created.series.as_ref().unwrap().cursor, "2026-11-26");

        // Idempotent occurrence completion advances cursor to 2027-05-26.
        let after_done = svc
            .act_on_occurrence(created.id, Some("2026-11-26"), OccurrenceActionStatus::Completed)
            .await
            .unwrap();
        assert_eq!(after_done.series.as_ref().unwrap().cursor, "2027-05-26");
        assert_eq!(after_done.series.as_ref().unwrap().history.len(), 1);

        // Second call with same key is idempotent.
        let idempotent = svc
            .act_on_occurrence(created.id, Some("2026-11-26"), OccurrenceActionStatus::Completed)
            .await
            .unwrap();
        assert_eq!(idempotent.series.as_ref().unwrap().cursor, "2027-05-26");
        assert_eq!(idempotent.series.as_ref().unwrap().history.len(), 1);

        // Stale ETag update returns TaskConflict.
        let err = svc
            .update_task(
                created.id,
                UpdateTaskInput {
                    title: Some("改名".into()),
                    etag: Some(created.etag.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::TaskConflict { .. }));

        // Simulate official app corrupting the ZSM1 block while editing description.
        provider
            .simulate_external_edit(
                created.id,
                "续费 eSIM",
                "<h1>续费 eSIM</h1><p>摘要</p><hr><p>官方改过的新备注</p><hr><p>ZSM1:{broken</p>",
            )
            .await;

        let summary = svc.sync().await.unwrap();
        assert_eq!(summary.recovered_count, 1);

        // Metadata (repeat + reminders + history) is recovered AND user's new description is kept!
        let recovered = svc.get_task(created.id, false).await.unwrap();
        assert_eq!(recovered.description, "官方改过的新备注");
        assert_eq!(recovered.reminders.len(), 1);
        assert_eq!(recovered.repeat.as_ref().unwrap().interval, 6);
        assert_eq!(recovered.series.as_ref().unwrap().cursor, "2027-05-26");
    }

    #[tokio::test]
    async fn calendar_expansion_and_single_occurrence_override() {
        let (svc, _provider) = setup().await;

        let weekly = svc
            .create_task(CreateTaskInput {
                title: "每周一例会".into(),
                description: String::new(),
                priority: Priority::Normal,
                list: Some("工作".into()),
                labels: vec![],
                pinned: false,
                schedule: Schedule {
                    all_day: false,
                    due: Some(due_point("2026-11-02", Some("10:00"))),
                    timezone: "Asia/Shanghai".into(),
                },
                reminders: vec![],
                repeat: Some(RepeatRule {
                    freq: RepeatFreq::Weekly,
                    interval: 1,
                    calendar: Default::default(),
                    by_weekday: Some(vec!["MO".into()]),
                    by_set_pos: None,
                    by_month_day: None,
                    by_month: None,
                    lunar: None,
                    day_filter: None,
                    on_invalid_date: Default::default(),
                    basis: Default::default(),
                    catch_up: Default::default(),
                    end: Default::default(),
                    dtstart: "2026-11-02".into(),
                }),
            })
            .await
            .unwrap();

        let items = svc
            .list_calendar_items("2026-11-01", "2026-11-30", true)
            .unwrap();
        let dates: Vec<&str> = items.iter().map(|i| i.date.as_str()).collect();
        assert_eq!(
            dates,
            vec!["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]
        );

        // Drag-reschedule only the 2026-11-16 occurrence to 2026-11-17.
        svc.override_occurrence(weekly.id, "2026-11-16", "2026-11-17", None)
            .await
            .unwrap();

        let items_after = svc
            .list_calendar_items("2026-11-01", "2026-11-30", true)
            .unwrap();
        let dates_after: Vec<&str> = items_after.iter().map(|i| i.date.as_str()).collect();
        assert_eq!(
            dates_after,
            vec!["2026-11-02", "2026-11-09", "2026-11-17", "2026-11-23", "2026-11-30"]
        );

        // Clear the single-instance override and ensure it snaps back to 2026-11-16.
        svc.clear_occurrence_override(weekly.id, "2026-11-16")
            .await
            .unwrap();
        let items_restored = svc
            .list_calendar_items("2026-11-01", "2026-11-30", true)
            .unwrap();
        let dates_restored: Vec<&str> = items_restored.iter().map(|i| i.date.as_str()).collect();
        assert_eq!(
            dates_restored,
            vec!["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]
        );
    }
}
