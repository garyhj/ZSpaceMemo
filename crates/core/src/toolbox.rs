use crate::error::{AppError, AppResult};
use crate::provider::official_cli::OfficialCliNotebookProvider;
use crate::storage::LocalStorage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NasEventNotice {
    pub id: String,
    pub title: String,
    pub body: String,
    pub level: String,
    pub time: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemOverview {
    pub system: Option<Value>,
    pub storage: Option<Value>,
    pub disk: Option<Value>,
    pub errors: Vec<String>,
}

/// Official `zspace-cli` toolbox adapter (File Drop/Search, NAS Status & Events, Docker Dashboard).
pub struct ToolboxService {
    provider: Arc<OfficialCliNotebookProvider>,
    storage: Arc<LocalStorage>,
}

impl ToolboxService {
    pub fn new(
        provider: Arc<OfficialCliNotebookProvider>,
        storage: Arc<LocalStorage>,
    ) -> Self {
        Self { provider, storage }
    }

    // --- File Drop & Search ---

    pub async fn file_space(&self) -> AppResult<Value> {
        self.provider
            .run_cli(&["file", "space", "--params", "{}"], None)
            .await
    }

    pub async fn file_list(&self, path: &str, start: u32, num: u32) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({
            "path": path,
            "start": start,
            "num": num,
            "sortby": "time",
            "order": "desc"
        }))?;
        self.provider
            .run_cli(&["file", "list", "--params", &params], None)
            .await
    }

    pub async fn search_files(&self, name: &str, file_path: Option<&str>) -> AppResult<Value> {
        let mut obj = json!({
            "name": name,
            "start": 0,
            "num": 50
        });
        if let Some(fp) = file_path.filter(|s| !s.trim().is_empty()) {
            obj["file_path"] = json!(fp);
        }
        let params = serde_json::to_string(&obj)?;
        self.provider
            .run_cli(&["search", "files", "--params", &params], None)
            .await
    }

    pub async fn mkdir(&self, parent: &str, name: &str) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({
            "parent": parent,
            "name": name.trim(),
            "rename": 1
        }))?;
        self.provider
            .run_cli(&["file", "mkdir", "--params", &params, "--yes"], None)
            .await
    }

    pub async fn upload_file(
        &self,
        local_path: &str,
        dest_dir: &str,
        rename_on_conflict: bool,
    ) -> AppResult<Value> {
        let path = Path::new(local_path);
        if !path.is_file() {
            return Err(AppError::Validation(format!(
                "仅支持上传单个文件（不支持文件夹）：{local_path}"
            )));
        }
        let parent = path
            .parent()
            .ok_or_else(|| AppError::Validation("无法解析本地文件所在目录".into()))?;
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| AppError::Validation("无效的文件名".into()))?;
        let dest_path = format!("{}/{}", dest_dir.trim_end_matches('/'), file_name);

        let mut obj = json!({
            "local_path": file_name,
            "dest_path": dest_path,
        });
        if rename_on_conflict {
            obj["rename"] = json!(1);
        }
        let params = serde_json::to_string(&obj)?;
        self.provider
            .run_cli(&["file", "upload", "--params", &params, "--yes"], Some(parent))
            .await
    }

    pub async fn download_file(&self, nas_path: &str, local_dest: &str) -> AppResult<Value> {
        let dest = Path::new(local_dest);
        let parent = dest
            .parent()
            .ok_or_else(|| AppError::Validation("无法解析目标保存目录".into()))?;
        let file_name = dest
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| AppError::Validation("无效的保存文件名".into()))?;
        let params = serde_json::to_string(&json!({
            "path": nas_path,
            "local_path": file_name,
            "overwrite": true
        }))?;
        self.provider
            .run_cli(
                &["file", "download", "--params", &params, "--yes"],
                Some(parent),
            )
            .await
    }

    // --- NAS System Status & Events ---

    pub async fn system_overview(&self) -> AppResult<SystemOverview> {
        let p_sys = serde_json::to_string(&json!({
            "fields": ["basic", "cpu", "memory", "fan", "network", "disk"],
            "include_polling": true
        }))?;
        let p_disk = serde_json::to_string(&json!({
            "include": ["mounts", "statics"]
        }))?;

        let a_sys = ["system", "info", "--params", p_sys.as_str()];
        let a_stg = ["storage", "info", "--params", "{}"];
        let a_disk = ["system", "disk", "--params", p_disk.as_str()];
        let (sys_res, stg_res, disk_res) = tokio::join!(
            self.provider.run_cli(&a_sys, None),
            self.provider.run_cli(&a_stg, None),
            self.provider.run_cli(&a_disk, None),
        );

        let mut errors = Vec::new();
        let system = match sys_res {
            Ok(v) => Some(v),
            Err(e) => {
                errors.push(e.to_string());
                None
            }
        };
        let storage = match stg_res {
            Ok(v) => Some(v),
            Err(e) => {
                errors.push(e.to_string());
                None
            }
        };
        let disk = match disk_res {
            Ok(v) => Some(v),
            Err(e) => {
                errors.push(e.to_string());
                None
            }
        };

        if system.is_none() && storage.is_none() && disk.is_none() {
            return Err(AppError::NasUnavailable(errors.join("; ")));
        }

        Ok(SystemOverview {
            system,
            storage,
            disk,
            errors,
        })
    }

    pub async fn list_events(&self, event_type: &str, num: u32) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({
            "action": "list",
            "event_type": event_type,
            "start_id": 0,
            "is_new": -1,
            "num": num
        }))?;
        self.provider
            .run_cli(&["system", "events", "--params", &params], None)
            .await
    }

    pub async fn mark_events_read(&self, ids: &str) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({
            "action": "mark_read",
            "ids": ids
        }))?;
        self.provider
            .run_cli(&["system", "events", "--params", &params, "--yes"], None)
            .await
    }

    pub async fn mark_all_events_read(&self) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({
            "action": "mark_all_read",
            "all": true
        }))?;
        self.provider
            .run_cli(&["system", "events", "--params", &params, "--yes"], None)
            .await
    }

    /// Poll newly arrived NAS notification events and deduplicate via SQLite.
    /// On the very first run, seeds existing unread events without spamming notifications.
    pub async fn poll_new_nas_notifications(&self) -> AppResult<Vec<NasEventNotice>> {
        let params = serde_json::to_string(&json!({
            "action": "list",
            "event_type": "notify",
            "start_id": 0,
            "is_new": 1,
            "num": 15
        }))?;
        let data = self
            .provider
            .run_cli(&["system", "events", "--params", &params], None)
            .await?;

        let items = extract_array(&data, &["list", "events", "items", "data"]);
        let seeded = self.storage.has_any_seen_nas_events()?;
        let mut out = Vec::new();

        for item in items {
            let id = item
                .get("id")
                .or_else(|| item.get("event_id"))
                .and_then(|v| {
                    v.as_i64()
                        .map(|n| n.to_string())
                        .or_else(|| v.as_str().map(|s| s.to_string()))
                })
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            if self.storage.is_nas_event_seen(&id)? {
                continue;
            }
            self.storage.mark_nas_event_seen(&id)?;
            if !seeded {
                // Seed initial unread backlog silently so first startup does not flood.
                continue;
            }
            let title = pick_str(&item, &["title", "event_name", "group", "action"])
                .unwrap_or_else(|| "极空间 NAS 消息".into());
            let body = pick_str(&item, &["content", "message", "msg", "desc", "detail"])
                .unwrap_or_else(|| title.clone());
            let level = pick_str(&item, &["level", "severity"]).unwrap_or_else(|| "info".into());
            let time = pick_str(&item, &["created_at", "time", "ctime", "create_time"])
                .unwrap_or_default();
            out.push(NasEventNotice {
                id,
                title,
                body,
                level,
                time,
            });
        }

        Ok(out)
    }

    // --- Docker Dashboard ---

    pub async fn docker_list(&self) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({ "action": "list" }))?;
        self.provider
            .run_cli(&["docker", "containers", "--params", &params], None)
            .await
    }

    pub async fn docker_stats(&self) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({ "action": "stats" }))?;
        self.provider
            .run_cli(&["docker", "containers", "--params", &params], None)
            .await
    }

    pub async fn docker_action(&self, action: &str, container_id: &str) -> AppResult<Value> {
        if !matches!(action, "start" | "stop" | "restart") {
            return Err(AppError::Validation(format!("不支持的容器操作: {action}")));
        }
        let params = serde_json::to_string(&json!({
            "action": action,
            "container_id": container_id
        }))?;
        self.provider
            .run_cli(&["docker", "containers", "--params", &params, "--yes"], None)
            .await
    }

    pub async fn docker_logs(&self, container_id: &str) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({
            "action": "logs",
            "container_id": container_id
        }))?;
        self.provider
            .run_cli(&["docker", "containers", "--params", &params], None)
            .await
    }
}

fn extract_array<'a>(val: &'a Value, keys: &[&str]) -> Vec<&'a Value> {
    if let Some(arr) = val.as_array() {
        return arr.iter().collect();
    }
    for k in keys {
        if let Some(arr) = val.get(*k).and_then(|v| v.as_array()) {
            return arr.iter().collect();
        }
    }
    Vec::new()
}

fn pick_str(val: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = val.get(*k).and_then(|v| v.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}
