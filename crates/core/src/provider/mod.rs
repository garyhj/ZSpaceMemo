pub mod mock;
pub mod official_cli;

use crate::error::AppResult;
use crate::models::TaskAttachment;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub nas_id: Option<String>,
    pub expires_at: Option<i64>,
    pub profile: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteCategory {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub parent_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: i64,
    pub title: String,
    pub classify_id: i64,
    #[serde(default)]
    pub in_brief: String,
    #[serde(default)]
    pub pin_flag: i64,
    #[serde(default)]
    pub length: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawNote {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub classify_id: i64,
    #[serde(default)]
    pub in_brief: String,
    #[serde(default)]
    pub pin_flag: i64,
    #[serde(default)]
    pub length: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteHistoryEntry {
    pub id: i64,
    pub body: Option<String>,
    pub updated_at: Option<i64>,
}

/// Abstract provider boundary between ZSpace Memo business logic and the underlying NAS client.
#[async_trait]
pub trait NotebookProvider: Send + Sync {
    async fn auth_status(&self) -> AppResult<AuthStatus>;
    async fn list_categories(&self) -> AppResult<Vec<NoteCategory>>;
    async fn create_category(&self, name: &str) -> AppResult<i64>;
    async fn list_notes(
        &self,
        classify_id: i64,
        start: u32,
        num: u32,
    ) -> AppResult<Vec<NoteSummary>>;
    async fn get_note(&self, id: i64) -> AppResult<RawNote>;
    async fn create_note(
        &self,
        title: &str,
        body: &str,
        classify_id: i64,
        in_brief: &str,
    ) -> AppResult<RawNote>;
    async fn update_note(&self, id: i64, title: &str, body: &str, in_brief: &str) -> AppResult<()>;
    async fn pin_note(&self, id: i64, pinned: bool) -> AppResult<()>;
    async fn delete_note(&self, id: i64) -> AppResult<()>;
    async fn list_history(&self, note_id: i64) -> AppResult<Vec<NoteHistoryEntry>>;
    async fn upload_note_attachment(
        &self,
        note_id: i64,
        local_path: &Path,
    ) -> AppResult<TaskAttachment>;
    async fn download_note_attachment(
        &self,
        attachment: &TaskAttachment,
        local_dest: &Path,
    ) -> AppResult<()>;
}
