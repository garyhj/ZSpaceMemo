use crate::codec::{
    compute_etag, h1_re, hr_split_re, html_to_markdown, markdown_to_html, strip_tags_re,
    unix_to_iso,
};
use crate::error::{AppError, AppResult};
use crate::provider::{NotebookProvider, RawNote};
use crate::storage::LocalStorage;
use chrono::Utc;
use html_escape::{decode_html_entities, encode_text};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;
use tracing::warn;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum StickyColor {
    #[default]
    Yellow,
    Blue,
    Green,
    Pink,
    Purple,
    White,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StickyNote {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub color: StickyColor,
    pub pinned: bool,
    pub floating: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub rev: u64,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateStickyInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub color: StickyColor,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub floating: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateStickyInput {
    pub title: Option<String>,
    pub content: Option<String>,
    pub color: Option<StickyColor>,
    pub pinned: Option<bool>,
    pub floating: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StickyMetaV1 {
    #[serde(default = "default_v")]
    v: u32,
    #[serde(default = "default_rev")]
    rev: u64,
    #[serde(default)]
    color: StickyColor,
    #[serde(default)]
    floating: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
}

fn default_v() -> u32 {
    1
}
fn default_rev() -> u64 {
    1
}

pub fn encode_sticky_note(note: &StickyNote) -> (String, String, String) {
    let display_title = if note.title.trim().is_empty() {
        note.content
            .lines()
            .find(|l| !l.trim().is_empty())
            .map(|l| l.trim().chars().take(30).collect())
            .unwrap_or_else(|| "便签".to_string())
    } else {
        note.title.trim().to_string()
    };

    let meta = StickyMetaV1 {
        v: 1,
        rev: note.rev.max(1),
        color: note.color,
        floating: note.floating,
        created_at: note.created_at.clone(),
    };
    let meta_json = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());

    let mut html = format!("<h1>{}</h1>", encode_text(&display_title));
    if !note.content.trim().is_empty() {
        html.push_str(&markdown_to_html(&note.content));
    } else {
        html.push_str("<p><br></p>");
    }
    html.push_str("<hr>");
    html.push_str("<p>⚙ ZSpace Kit 便签（请勿手动修改）</p>");
    html.push_str(&format!("<p>ZSK1:{}</p>", encode_text(&meta_json)));

    let in_brief = note
        .content
        .lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().chars().take(80).collect())
        .unwrap_or_else(|| display_title.clone());

    (display_title, html, in_brief)
}

pub fn decode_sticky_note(raw: &RawNote) -> StickyNote {
    let body_no_h1 = h1_re().replace(&raw.body, "").to_string();
    let mut meta: Option<StickyMetaV1> = None;
    let mut content_html = body_no_h1.as_str();

    if let Some(pos) = body_no_h1.rfind("ZSK1:") {
        let after = &body_no_h1[pos + 5..];
        let end_tag = after.find("</").unwrap_or(after.len());
        let raw_json_slice = &after[..end_tag];
        let clean = decode_html_entities(&strip_tags_re().replace_all(raw_json_slice, ""))
            .trim()
            .to_string();
        if let Ok(parsed) = serde_json::from_str::<StickyMetaV1>(&clean) {
            meta = Some(parsed);
        }
        // Cut off footer starting from the last <hr> before ZSK1:
        let prefix = &body_no_h1[..pos];
        if let Some(last_hr) = hr_split_re().find_iter(prefix).last() {
            content_html = &prefix[..last_hr.start()];
        } else {
            content_html = prefix;
        }
    }

    let content = html_to_markdown(content_html);
    let m = meta.unwrap_or(StickyMetaV1 {
        v: 1,
        rev: 1,
        color: StickyColor::Yellow,
        floating: false,
        created_at: None,
    });
    let etag = compute_etag(m.rev, &raw.body);

    StickyNote {
        id: raw.id,
        title: decode_html_entities(raw.title.trim()).to_string(),
        content,
        color: m.color,
        pinned: raw.pin_flag != 0,
        floating: m.floating,
        created_at: m.created_at.or_else(|| unix_to_iso(raw.created_at)),
        updated_at: unix_to_iso(raw.updated_at),
        rev: m.rev,
        etag,
    }
}

pub struct StickyService<P: NotebookProvider> {
    provider: Arc<P>,
    storage: Arc<LocalStorage>,
    sync_lock: AsyncMutex<()>,
    note_locks: StdMutex<HashMap<i64, Arc<AsyncMutex<()>>>>,
    dirty_during_sync: StdMutex<HashSet<i64>>,
    deleted_during_sync: StdMutex<HashSet<i64>>,
}

impl<P: NotebookProvider> StickyService<P> {
    pub fn new(provider: Arc<P>, storage: Arc<LocalStorage>) -> Self {
        Self {
            provider,
            storage,
            sync_lock: AsyncMutex::new(()),
            note_locks: StdMutex::new(HashMap::new()),
            dirty_during_sync: StdMutex::new(HashSet::new()),
            deleted_during_sync: StdMutex::new(HashSet::new()),
        }
    }

    fn note_lock(&self, id: i64) -> Arc<AsyncMutex<()>> {
        let mut map = self
            .note_locks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        map.entry(id)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn mark_dirty(&self, id: i64) {
        self.dirty_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id);
        self.deleted_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    }

    fn mark_deleted(&self, id: i64) {
        self.deleted_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id);
        self.dirty_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    }

    pub async fn initialize_category(&self, create_if_missing: bool) -> AppResult<i64> {
        let mut settings = self.storage.load_settings()?;
        let cats = self.provider.list_categories().await?;

        if let Some(cid) = settings.sticky_category_id {
            if cats.iter().any(|c| c.id == cid) {
                return Ok(cid);
            }
        }
        if let Some(found) = cats.iter().find(|c| c.name == settings.sticky_category_name) {
            settings.sticky_category_id = Some(found.id);
            self.storage.save_settings(&settings)?;
            return Ok(found.id);
        }
        if !create_if_missing {
            return Err(AppError::Validation("未找到极空间便签专用分类".into()));
        }
        let cid = self.provider.create_category(&settings.sticky_category_name).await?;
        settings.sticky_category_id = Some(cid);
        self.storage.save_settings(&settings)?;
        Ok(cid)
    }

    async fn ensure_category_id(&self) -> AppResult<i64> {
        let settings = self.storage.load_settings()?;
        if let Some(cid) = settings.sticky_category_id {
            return Ok(cid);
        }
        self.initialize_category(true).await
    }

    pub async fn sync(&self) -> AppResult<usize> {
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

        let cat_id = self.ensure_category_id().await?;
        let mut start = 0u32;
        let page = 100u32;
        let mut summaries = Vec::new();
        loop {
            let batch = self.provider.list_notes(cat_id, start, page).await?;
            let count = batch.len() as u32;
            summaries.extend(batch);
            if count < page {
                break;
            }
            start += page;
        }

        let mut seen_ids: HashSet<i64> = summaries.iter().map(|s| s.id).collect();
        let mut fetched = 0usize;

        for s in summaries {
            let need_fetch = match self.storage.get_sticky(s.id)? {
                Some((u, l, raw_json)) => {
                    let meta_changed = serde_json::from_str::<StickyNote>(&raw_json)
                        .map(|n| {
                            n.pinned != (s.pin_flag != 0)
                                || n.title != decode_html_entities(s.title.trim()).as_ref()
                        })
                        .unwrap_or(true);
                    u != s.updated_at || l != s.length || meta_changed
                }
                None => true,
            };
            if need_fetch {
                let raw = match self.provider.get_note(s.id).await {
                    Ok(r) => r,
                    Err(AppError::TaskNotFound(_)) => {
                        seen_ids.remove(&s.id);
                        continue;
                    }
                    Err(e) => {
                        warn!(sticky_id = s.id, error = %e, "sticky fetch skipped during sync");
                        continue;
                    }
                };
                let concurrently_touched = {
                    let dirty = self
                        .dirty_during_sync
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    let deleted = self
                        .deleted_during_sync
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    dirty.contains(&s.id) || deleted.contains(&s.id)
                };
                if concurrently_touched {
                    continue;
                }
                let note = decode_sticky_note(&raw);
                let json = serde_json::to_string(&note)?;
                self.storage.upsert_sticky(s.id, raw.updated_at, s.length, &json)?;
                fetched += 1;
            }
        }

        let dirty_snapshot: HashSet<i64> = self
            .dirty_during_sync
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        for raw_cached in self.storage.list_stickies()? {
            if let Ok(note) = serde_json::from_str::<StickyNote>(&raw_cached) {
                if !seen_ids.contains(&note.id) && !dirty_snapshot.contains(&note.id) {
                    self.storage.delete_sticky(note.id)?;
                }
            }
        }

        Ok(fetched)
    }

    pub fn list_notes(&self, keyword: Option<&str>) -> AppResult<Vec<StickyNote>> {
        let kw = keyword.map(|k| k.trim().to_lowercase()).filter(|k| !k.is_empty());
        let mut out = Vec::new();
        for json in self.storage.list_stickies()? {
            if let Ok(note) = serde_json::from_str::<StickyNote>(&json) {
                if let Some(ref k) = kw {
                    if !note.title.to_lowercase().contains(k)
                        && !note.content.to_lowercase().contains(k)
                    {
                        continue;
                    }
                }
                out.push(note);
            }
        }
        out.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(out)
    }

    pub fn get_note(&self, id: i64) -> AppResult<Option<StickyNote>> {
        match self.storage.get_sticky(id)? {
            Some((_, _, json)) => Ok(serde_json::from_str(&json).ok()),
            None => Ok(None),
        }
    }

    pub async fn create_note(&self, input: CreateStickyInput) -> AppResult<StickyNote> {
        let cat_id = self.ensure_category_id().await?;
        let now = Utc::now().to_rfc3339();
        let mut note = StickyNote {
            id: 0,
            title: input.title.trim().to_string(),
            content: input.content,
            color: input.color,
            pinned: input.pinned,
            floating: input.floating,
            created_at: Some(now.clone()),
            updated_at: Some(now),
            rev: 1,
            etag: String::new(),
        };
        let (title, body, in_brief) = encode_sticky_note(&note);
        let raw = self.provider.create_note(&title, &body, cat_id, &in_brief).await?;
        if note.pinned {
            self.provider.pin_note(raw.id, true).await?;
        }
        note.id = raw.id;
        note.title = title;
        note.updated_at = unix_to_iso(raw.updated_at).or(note.updated_at);
        note.etag = compute_etag(note.rev, &body);
        self.mark_dirty(note.id);
        let json = serde_json::to_string(&note)?;
        self.storage
            .upsert_sticky(note.id, raw.updated_at, body.len() as i64, &json)?;
        Ok(note)
    }

    pub async fn update_note(&self, id: i64, patch: UpdateStickyInput) -> AppResult<StickyNote> {
        let lock = self.note_lock(id);
        let _guard = lock.lock().await;

        let mut note = match self.provider.get_note(id).await {
            Ok(raw) => decode_sticky_note(&raw),
            Err(AppError::TaskNotFound(_)) => return Err(AppError::TaskNotFound(id)),
            Err(_) => self.get_note(id)?.ok_or(AppError::TaskNotFound(id))?,
        };
        let old_pinned = note.pinned;
        if let Some(t) = patch.title {
            note.title = t.trim().to_string();
        }
        if let Some(c) = patch.content {
            note.content = c;
        }
        if let Some(col) = patch.color {
            note.color = col;
        }
        if let Some(p) = patch.pinned {
            note.pinned = p;
        }
        if let Some(f) = patch.floating {
            note.floating = f;
        }
        note.rev += 1;
        note.updated_at = Some(Utc::now().to_rfc3339());

        let (title, body, in_brief) = encode_sticky_note(&note);
        note.title = title.clone();
        note.etag = compute_etag(note.rev, &body);
        self.provider
            .update_note(id, &title, &body, &in_brief)
            .await?;
        if note.pinned != old_pinned {
            self.provider.pin_note(id, note.pinned).await?;
        }

        self.mark_dirty(id);
        let json = serde_json::to_string(&note)?;
        self.storage
            .upsert_sticky(id, Utc::now().timestamp(), body.len() as i64, &json)?;
        Ok(note)
    }

    pub async fn delete_note(&self, id: i64) -> AppResult<()> {
        let lock = self.note_lock(id);
        let _guard = lock.lock().await;
        self.mark_deleted(id);
        self.provider.delete_note(id).await?;
        self.storage.delete_sticky(id)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::mock::MockNotebookProvider;

    #[tokio::test]
    async fn sticky_crud_roundtrip_and_sync() {
        let provider = Arc::new(MockNotebookProvider::new());
        let storage = Arc::new(LocalStorage::open_in_memory().unwrap());
        let svc = StickyService::new(provider.clone(), storage.clone());

        let created = svc
            .create_note(CreateStickyInput {
                title: "VPN 端口".into(),
                content: "WireGuard: 51820\nNAS 内网: 192.168.1.10".into(),
                color: StickyColor::Blue,
                pinned: true,
                floating: false,
            })
            .await
            .unwrap();
        assert_eq!(created.color, StickyColor::Blue);
        assert!(created.pinned);

        let updated = svc
            .update_note(
                created.id,
                UpdateStickyInput {
                    color: Some(StickyColor::Green),
                    floating: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.color, StickyColor::Green);
        assert!(updated.floating);

        // Fresh storage rebuilds cleanly from NAS via sync.
        let storage2 = Arc::new(LocalStorage::open_in_memory().unwrap());
        let svc2 = StickyService::new(provider, storage2);
        let fetched = svc2.sync().await.unwrap();
        assert_eq!(fetched, 1);
        let list = svc2.list_notes(None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "VPN 端口");
        assert_eq!(list[0].color, StickyColor::Green);
        assert!(list[0].floating);
    }
}
