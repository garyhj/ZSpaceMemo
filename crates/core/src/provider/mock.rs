use crate::error::{AppError, AppResult};
use crate::provider::{AuthStatus, NoteCategory, NoteHistoryEntry, NoteSummary, NotebookProvider, RawNote};
use async_trait::async_trait;
use chrono::Utc;
use std::collections::BTreeMap;
use tokio::sync::Mutex;

#[derive(Default)]
struct MockState {
    next_cat_id: i64,
    next_note_id: i64,
    categories: BTreeMap<i64, NoteCategory>,
    notes: BTreeMap<i64, RawNote>,
    history: BTreeMap<i64, Vec<NoteHistoryEntry>>,
}

/// In-memory NotebookProvider for fast, deterministic unit & integration testing.
pub struct MockNotebookProvider {
    state: Mutex<MockState>,
}

impl MockNotebookProvider {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(MockState {
                next_cat_id: 10,
                next_note_id: 100,
                categories: BTreeMap::new(),
                notes: BTreeMap::new(),
                history: BTreeMap::new(),
            }),
        }
    }

    /// Simulate an external edit made in the official ZSpace Notes app.
    pub async fn simulate_external_edit(&self, id: i64, new_title: &str, new_body: &str) {
        let mut s = self.state.lock().await;
        if let Some(n) = s.notes.get_mut(&id) {
            let prev_body = n.body.clone();
            let prev_ts = n.updated_at;
            n.title = new_title.to_string();
            n.body = new_body.to_string();
            n.length = new_body.len() as i64;
            n.updated_at = Utc::now().timestamp() + 1;
            let hlist = s.history.entry(id).or_default();
            let hid = (hlist.len() as i64) + 1;
            hlist.insert(
                0,
                NoteHistoryEntry {
                    id: hid,
                    body: Some(prev_body),
                    updated_at: Some(prev_ts),
                },
            );
        }
    }
}

impl Default for MockNotebookProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl NotebookProvider for MockNotebookProvider {
    async fn auth_status(&self) -> AppResult<AuthStatus> {
        Ok(AuthStatus {
            logged_in: true,
            nas_id: Some("MOCK-NAS".into()),
            expires_at: Some(Utc::now().timestamp() + 3600),
            profile: "mock".into(),
            mode: Some("mock".into()),
            host: None,
        })
    }

    async fn list_categories(&self) -> AppResult<Vec<NoteCategory>> {
        let s = self.state.lock().await;
        Ok(s.categories.values().cloned().collect())
    }

    async fn create_category(&self, name: &str) -> AppResult<i64> {
        let mut s = self.state.lock().await;
        let id = s.next_cat_id;
        s.next_cat_id += 1;
        s.categories.insert(
            id,
            NoteCategory {
                id,
                name: name.to_string(),
                parent_id: 0,
            },
        );
        Ok(id)
    }

    async fn list_notes(&self, classify_id: i64, start: u32, num: u32) -> AppResult<Vec<NoteSummary>> {
        let s = self.state.lock().await;
        let mut list: Vec<NoteSummary> = s
            .notes
            .values()
            .filter(|n| n.classify_id == classify_id)
            .map(|n| NoteSummary {
                id: n.id,
                title: n.title.clone(),
                classify_id: n.classify_id,
                in_brief: n.in_brief.clone(),
                pin_flag: n.pin_flag,
                length: n.length,
                updated_at: n.updated_at,
                created_at: n.created_at,
            })
            .collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(list
            .into_iter()
            .skip(start as usize)
            .take(num as usize)
            .collect())
    }

    async fn get_note(&self, id: i64) -> AppResult<RawNote> {
        let s = self.state.lock().await;
        s.notes.get(&id).cloned().ok_or(AppError::TaskNotFound(id))
    }

    async fn create_note(
        &self,
        title: &str,
        body: &str,
        classify_id: i64,
        in_brief: &str,
    ) -> AppResult<RawNote> {
        let mut s = self.state.lock().await;
        let id = s.next_note_id;
        s.next_note_id += 1;
        let note = RawNote {
            id,
            title: title.to_string(),
            body: body.to_string(),
            classify_id,
            in_brief: in_brief.to_string(),
            pin_flag: 0,
            length: body.len() as i64,
            updated_at: Utc::now().timestamp(),
            created_at: 0,
        };
        s.notes.insert(id, note.clone());
        Ok(note)
    }

    async fn update_note(&self, id: i64, title: &str, body: &str, in_brief: &str) -> AppResult<()> {
        let mut s = self.state.lock().await;
        let n = s.notes.get_mut(&id).ok_or(AppError::TaskNotFound(id))?;
        n.title = title.to_string();
        n.body = body.to_string();
        n.in_brief = in_brief.to_string();
        n.length = body.len() as i64;
        n.updated_at = Utc::now().timestamp();
        Ok(())
    }

    async fn pin_note(&self, id: i64, pinned: bool) -> AppResult<()> {
        let mut s = self.state.lock().await;
        let n = s.notes.get_mut(&id).ok_or(AppError::TaskNotFound(id))?;
        n.pin_flag = if pinned { 1 } else { 0 };
        Ok(())
    }

    async fn delete_note(&self, id: i64) -> AppResult<()> {
        let mut s = self.state.lock().await;
        s.notes.remove(&id);
        Ok(())
    }

    async fn list_history(&self, note_id: i64) -> AppResult<Vec<NoteHistoryEntry>> {
        let s = self.state.lock().await;
        Ok(s.history.get(&note_id).cloned().unwrap_or_default())
    }
}
