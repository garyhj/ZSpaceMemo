use crate::codec::{decode_task_note, encode_task_note};
use crate::error::{AppError, AppResult};
use crate::models::{MetaState, Task};
use crate::provider::NotebookProvider;
use crate::storage::{AppSettings, LocalStorage};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, warn};

mod mutations;
mod queries;
mod reminders;
#[cfg(test)]
mod tests;

pub(super) const MAX_HISTORY_ENTRIES: usize = 200;

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
    pub(super) provider: Arc<P>,
    pub(super) storage: Arc<LocalStorage>,
    pub(super) sync_lock: AsyncMutex<()>,
    pub(super) task_locks: StdMutex<HashMap<i64, Arc<AsyncMutex<()>>>>,
    pub(super) dirty_during_sync: StdMutex<HashSet<i64>>,
    pub(super) deleted_during_sync: StdMutex<HashSet<i64>>,
    pub(super) last_sync_at: StdMutex<Option<DateTime<Utc>>>,
}

pub(super) struct ComputedDueInfo {
    pub(super) eff_key: Option<String>,
    pub(super) due: Option<(String, Option<String>, bool)>,
    pub(super) overdue: bool,
    pub(super) today_tz: String,
}

impl<P: NotebookProvider> TaskService<P> {
    pub fn new(provider: Arc<P>, storage: Arc<LocalStorage>) -> Self {
        Self {
            provider,
            storage,
            sync_lock: AsyncMutex::new(()),
            task_locks: StdMutex::new(HashMap::new()),
            dirty_during_sync: StdMutex::new(HashSet::new()),
            deleted_during_sync: StdMutex::new(HashSet::new()),
            last_sync_at: StdMutex::new(None),
        }
    }

    pub fn synced_within(&self, max_age_secs: i64) -> bool {
        let guard = self.last_sync_at.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .map(|prev| (Utc::now() - prev).num_seconds() < max_age_secs)
            .unwrap_or(false)
    }

    pub(super) fn task_lock(&self, id: i64) -> Arc<AsyncMutex<()>> {
        let mut map = self.task_locks.lock().unwrap_or_else(|p| p.into_inner());
        map.entry(id)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    pub(super) fn mark_dirty(&self, id: i64) {
        self.dirty_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id);
        self.deleted_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    }

    pub(super) fn mark_deleted(&self, id: i64) {
        self.deleted_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id);
        self.dirty_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
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

    pub(super) fn require_category_id(&self) -> AppResult<i64> {
        self.storage
            .load_settings()?
            .todo_category_id
            .ok_or_else(|| {
                AppError::CategoryNotConfigured("尚未初始化 ZSpace Memo 专用分类".into())
            })
    }

    /// Incremental sync from NAS into local SQLite index cache + reminder job reconciliation.
    pub async fn sync(&self) -> AppResult<SyncSummary> {
        let _sync_guard = self.sync_lock.lock().await;
        {
            self.dirty_during_sync
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
            self.deleted_during_sync
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
        }

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

        let mut keep_set: HashSet<i64> = all_summaries.iter().map(|s| s.id).collect();
        let mut fetched_details = 0usize;
        let mut recovered_count = 0usize;

        for summary in &all_summaries {
            let cached = self.storage.get_cached_task(summary.id)?;
            let unchanged = cached.as_ref().is_some_and(|c| {
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

            let raw = match self.provider.get_note(summary.id).await {
                Ok(r) => r,
                Err(AppError::TaskNotFound(_)) => {
                    keep_set.remove(&summary.id);
                    continue;
                }
                Err(e) => {
                    warn!(task_id = summary.id, error = %e, "task fetch skipped during sync");
                    continue;
                }
            };
            fetched_details += 1;

            let concurrently_touched = {
                let dirty = self
                    .dirty_during_sync
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let deleted = self
                    .deleted_during_sync
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                dirty.contains(&summary.id) || deleted.contains(&summary.id)
            };
            if concurrently_touched {
                continue;
            }

            let mut decoded = decode_task_note(
                raw.id,
                &raw.title,
                &raw.body,
                raw.pin_flag != 0,
                raw.updated_at,
            );
            let was_corrupted = decoded.meta_corrupted;
            let mut wrote_back_recovery = false;

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
                    match self
                        .provider
                        .update_note(raw.id, &enc.title, &enc.body, &enc.in_brief)
                        .await
                    {
                        Ok(()) => {
                            decoded.task.etag = enc.etag;
                            wrote_back_recovery = true;
                        }
                        Err(e) => {
                            warn!(task_id = raw.id, error = %e, "failed writing recovered metadata to NAS; will retry next sync");
                        }
                    }
                }
            }

            let valid_for_cache = decoded.meta_present
                && !decoded.meta_corrupted
                && (!was_corrupted || wrote_back_recovery);
            let ts = if wrote_back_recovery {
                Utc::now().timestamp()
            } else {
                raw.updated_at
            };
            let len = if wrote_back_recovery {
                encode_task_note(&decoded.task).body.len() as i64
            } else {
                raw.length
            };
            self.storage
                .upsert_cached_task(&decoded.task, ts, len, valid_for_cache)?;

            // Only reconcile reminders when metadata is valid; if corrupted & unrecovered,
            // keep existing reminder jobs intact per DESIGN §4.3.
            if !decoded.meta_corrupted {
                self.reconcile_reminders(&decoded.task)?;
            }
        }

        {
            let dirty = self
                .dirty_during_sync
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let deleted = self
                .deleted_during_sync
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            for id in dirty.iter() {
                keep_set.insert(*id);
            }
            for id in deleted.iter() {
                keep_set.remove(id);
            }
        }
        let keep_ids: Vec<i64> = keep_set.into_iter().collect();
        self.storage.remove_cached_tasks_except(&keep_ids)?;
        let synced_now = Utc::now();
        *self.last_sync_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(synced_now);

        Ok(SyncSummary {
            total_notes: all_summaries.len(),
            fetched_details,
            recovered_count,
            synced_at: synced_now.to_rfc3339(),
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
                    warn!(
                        task_id = edited.id,
                        "recovered corrupted metadata from local cache"
                    );
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
                        warn!(
                            task_id = edited.id,
                            "recovered corrupted metadata from NAS history"
                        );
                        return Ok(Some(prev));
                    }
                }
            }
        }

        Ok(None)
    }
}
