use super::TaskService;
use crate::codec::{decode_task_note, encode_task_note};
use crate::error::{AppError, AppResult};
use crate::models::{
    CreateTaskInput, DateTimePoint, HistorySummary, MetaState, OccurrenceActionStatus,
    OccurrenceHistoryEntry, OccurrenceOverride, RepeatEnd, Schedule, SeriesState, Task, TaskStatus,
    UpdateTaskInput,
};
use crate::provider::NotebookProvider;
use crate::recurrence::{
    effective_current_key, generate_occurrences, next_after_action, parse_date,
};
use chrono::Utc;
use std::collections::BTreeMap;

impl<P: NotebookProvider> TaskService<P> {
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
            attachments: Vec::new(),
            completed_at: None,
            created_at: Some(now_iso),
            updated_at: None,
            source: "zspace_notebook".into(),
            meta_state: MetaState::Ok,
            rev: 1,
            etag: String::new(),
            meta_extra: BTreeMap::new(),
            effective_current_key: None,
            is_overdue: None,
        };

        let encoded = encode_task_note(&task);
        let created_raw = self
            .provider
            .create_note(&encoded.title, &encoded.body, cat_id, &encoded.in_brief)
            .await?;

        if task.pinned {
            self.provider.pin_note(created_raw.id, true).await?;
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
        self.mark_dirty(task.id);
        self.storage
            .upsert_cached_task(&task, verified.updated_at, verified.length, true)?;
        self.reconcile_reminders(&task)?;
        Ok(self.enrich_task_view(task))
    }

    pub async fn get_task(&self, id: i64, refresh: bool) -> AppResult<Task> {
        if !refresh {
            if let Some(c) = self.storage.get_cached_task(id)? {
                return Ok(self.enrich_task_view(c.task));
            }
        }
        let raw = self.provider.get_note(id).await?;
        let decoded = decode_task_note(
            raw.id,
            &raw.title,
            &raw.body,
            raw.pin_flag != 0,
            raw.updated_at,
        );
        let locked = self.task_lock(id);
        let _guard = locked.lock().await;
        self.storage.upsert_cached_task(
            &decoded.task,
            raw.updated_at,
            raw.length,
            decoded.meta_present && !decoded.meta_corrupted,
        )?;
        Ok(self.enrich_task_view(decoded.task))
    }

    async fn load_fresh_for_mutation(&self, id: i64) -> AppResult<Task> {
        let raw = self.provider.get_note(id).await?;
        let decoded = decode_task_note(
            raw.id,
            &raw.title,
            &raw.body,
            raw.pin_flag != 0,
            raw.updated_at,
        );
        Ok(decoded.task)
    }

    /// Update a task with optimistic concurrency check (ETag).
    pub async fn update_task(&self, id: i64, patch: UpdateTaskInput) -> AppResult<Task> {
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;

        let mut task = self.load_fresh_for_mutation(id).await?;

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

        if let Some(atts) = patch.attachments {
            task.attachments = atts;
        }

        let pin_changed = patch.pinned.map(|p| (p, p != task.pinned));
        if let Some((new_pin, _)) = pin_changed {
            task.pinned = new_pin;
        }

        self.persist_task_update(
            task,
            pin_changed.and_then(|(p, changed)| changed.then_some(p)),
        )
        .await
    }

    async fn persist_task_update(
        &self,
        mut task: Task,
        pin_update: Option<bool>,
    ) -> AppResult<Task> {
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
        self.mark_dirty(task.id);
        self.storage
            .upsert_cached_task(&task, now.timestamp(), encoded.body.len() as i64, true)?;
        self.reconcile_reminders(&task)?;
        Ok(self.enrich_task_view(task))
    }

    /// Idempotent complete/skip for a single task or a repeating occurrence.
    pub async fn act_on_occurrence(
        &self,
        id: i64,
        occurrence_key: Option<&str>,
        action: OccurrenceActionStatus,
    ) -> AppResult<Task> {
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;
        let mut task = self.load_fresh_for_mutation(id).await?;
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
                return Ok(self.enrich_task_view(task));
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
            if series.history.len() > super::MAX_HISTORY_ENTRIES {
                let overflow = series.history.split_off(super::MAX_HISTORY_ENTRIES);
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
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;
        let mut task = self.load_fresh_for_mutation(id).await?;
        let today = self.today_in_tz(&task.schedule.timezone);
        if let (Some(rule), Some(series)) = (&task.repeat, &mut task.series) {
            if let Some(k) = occurrence_key {
                series.history.retain(|h| h.key != k);
                if k < series.cursor.as_str() {
                    series.cursor = k.to_string();
                }
                series.ended_at = None;
                task.status = TaskStatus::Active;
            } else if series.ended_at.is_some() || task.status == TaskStatus::Ended {
                let reached_limit = match &rule.end {
                    RepeatEnd::Count { count } => {
                        let summary_total = series
                            .history_summary
                            .as_ref()
                            .map(|s| (s.completed + s.skipped) as usize)
                            .unwrap_or(0);
                        series.history.len() + summary_total >= *count as usize
                    }
                    RepeatEnd::Until { .. } => series
                        .history
                        .first()
                        .and_then(|h| {
                            let d = parse_date(&today).ok()?;
                            next_after_action(rule, &h.key, d).ok()
                        })
                        .is_some_and(|next_opt| next_opt.is_none()),
                    RepeatEnd::Never => false,
                };
                if reached_limit {
                    if let Some(last) = series.history.first().cloned() {
                        series.history.remove(0);
                        if last.key < series.cursor {
                            series.cursor = last.key;
                        }
                    }
                }
                series.ended_at = None;
                task.status = TaskStatus::Active;
            } else if let Some(last) = series.history.first().cloned() {
                series.history.remove(0);
                if last.key < series.cursor {
                    series.cursor = last.key;
                }
            }
        } else {
            task.status = TaskStatus::Pending;
            task.completed_at = None;
        }
        self.persist_task_update(task, None).await
    }

    pub async fn end_series(&self, id: i64) -> AppResult<Task> {
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;
        let mut task = self.load_fresh_for_mutation(id).await?;
        if let Some(series) = &mut task.series {
            series.ended_at = Some(Utc::now().to_rfc3339());
            task.status = TaskStatus::Ended;
        }
        self.persist_task_update(task, None).await
    }

    pub async fn delete_task(&self, id: i64) -> AppResult<()> {
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;
        self.mark_deleted(id);
        self.provider.delete_note(id).await?;
        self.storage.delete_cached_task(id)?;
        Ok(())
    }

    /// Upload a local file as a native ZSpace note attachment (`attachment_upload`) and record it in ZSM1.
    pub async fn upload_task_attachment(&self, id: i64, local_path: &str) -> AppResult<Task> {
        let path = std::path::Path::new(local_path);
        let meta = std::fs::symlink_metadata(path)
            .map_err(|e| AppError::Validation(format!("附件路径不可访问 {local_path}: {e}")))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(AppError::Validation(format!(
                "附件路径无效或不是常规文件：{local_path}"
            )));
        }
        const MAX_NOTE_ATTACHMENT_BYTES: u64 = 16 * 1024 * 1024;
        if meta.len() > MAX_NOTE_ATTACHMENT_BYTES {
            let mb = meta.len() as f64 / (1024.0 * 1024.0);
            return Err(AppError::Validation(format!(
                "极空间待办附件上限为 16 MB（当前文件 {mb:.1} MB），大文件请改用左侧「文件快传」"
            )));
        }
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;
        let mut task = self.load_fresh_for_mutation(id).await?;
        let att = self.provider.upload_note_attachment(id, path).await?;
        task.attachments
            .retain(|existing| existing.file_id != att.file_id);
        task.attachments.push(att);
        self.persist_task_update(task, None).await
    }

    /// Download an attached file from the native ZSpace note to `local_dest`.
    pub async fn download_task_attachment(
        &self,
        id: i64,
        file_id: &str,
        local_dest: &str,
    ) -> AppResult<()> {
        let task = self.get_task(id, false).await?;
        let att = task
            .attachments
            .iter()
            .find(|a| a.file_id == file_id)
            .cloned()
            .ok_or_else(|| {
                AppError::OccurrenceNotFound(format!("该待办不存在附件 ID {file_id}"))
            })?;
        self.provider
            .download_note_attachment(&att, std::path::Path::new(local_dest))
            .await
    }

    /// Unlink an attachment entry from this task's ZSM1 metadata (does not purge NAS notepad file storage).
    pub async fn remove_task_attachment(&self, id: i64, file_id: &str) -> AppResult<Task> {
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;
        let mut task = self.load_fresh_for_mutation(id).await?;
        let prev_len = task.attachments.len();
        task.attachments.retain(|a| a.file_id != file_id);
        if task.attachments.len() == prev_len {
            return Ok(self.enrich_task_view(task));
        }
        self.persist_task_update(task, None).await
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
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;
        let mut task = self.load_fresh_for_mutation(id).await?;
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
                    None => prev_sched
                        .map(|s| s.all_day)
                        .unwrap_or(task.schedule.all_day),
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
        let resolved_all_day =
            new_all_day.unwrap_or_else(|| task.schedule.all_day && new_due_time.is_none());
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
        let lock = self.task_lock(id);
        let _guard = lock.lock().await;
        let mut task = self.load_fresh_for_mutation(id).await?;
        if let Some(series) = &mut task.series {
            if series.overrides.remove(occurrence_key).is_some() {
                return self.persist_task_update(task, None).await;
            }
        }
        Ok(self.enrich_task_view(task))
    }
}
