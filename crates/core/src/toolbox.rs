use crate::error::{AppError, AppResult};
use crate::provider::official_cli::OfficialCliNotebookProvider;
use crate::storage::LocalStorage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_UPLOAD_FILES_PER_BATCH: usize = 500;
const MAX_UPLOAD_DIR_DEPTH: usize = 16;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteMkdirOp {
    pub parent: String,
    pub name: String,
    pub full_remote_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedUploadFile {
    pub local_path: PathBuf,
    pub display_name: String,
    pub dest_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UploadPlan {
    pub directories: Vec<RemoteMkdirOp>,
    pub files: Vec<PlannedUploadFile>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadBatchProgress {
    pub batch_id: String,
    pub job_id: String,
    pub name: String,
    pub local_path: String,
    pub dest_dir: String,
    pub status: String,
    pub error: Option<String>,
    pub current: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadBatchSummary {
    pub batch_id: String,
    pub total_files: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub created_dirs: usize,
    pub skipped_count: usize,
}

fn should_ignore_junk_name(name: &str) -> bool {
    matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini" | "._.DS_Store")
}

fn is_nas_entry_dir(val: &Value) -> bool {
    for key in ["is_dir", "isDir", "dir", "is_folder", "isFolder"] {
        if let Some(v) = val.get(key) {
            if let Some(b) = v.as_bool() {
                return b;
            }
            if let Some(n) = v.as_i64() {
                return n == 1;
            }
            if let Some(s) = v.as_str() {
                let lower = s.trim().to_ascii_lowercase();
                return matches!(lower.as_str(), "1" | "true" | "yes" | "dir" | "folder");
            }
        }
    }
    let ftype = val
        .get("ftype")
        .or_else(|| val.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(ftype.as_str(), "dir" | "folder")
}

fn extract_dir_children(val: &Value, base_dir: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let arr = extract_array(val, &["list", "files", "items", "data", "rows"]);
    let base = base_dir.trim_end_matches('/');
    for item in arr {
        if !is_nas_entry_dir(item) {
            continue;
        }
        let Some(name) = pick_str(item, &["name", "file_name", "filename"]) else {
            continue;
        };
        let path = pick_str(item, &["path", "file_path", "full_path"])
            .unwrap_or_else(|| format!("{base}/{name}"));
        map.insert(name, path);
    }
    map
}

fn walk_dir_for_upload(
    local_dir: &Path,
    remote_dir: &str,
    rel_prefix: &str,
    depth: usize,
    seen_dirs: &mut BTreeSet<String>,
    plan: &mut UploadPlan,
) -> AppResult<()> {
    if depth > MAX_UPLOAD_DIR_DEPTH {
        plan.skipped
            .push(format!("超过最大目录层级({MAX_UPLOAD_DIR_DEPTH}): {}", local_dir.display()));
        return Ok(());
    }
    let rd = std::fs::read_dir(local_dir).map_err(|e| {
        AppError::Validation(format!("读取目录失败 {}: {e}", local_dir.display()))
    })?;
    let mut entries: Vec<std::fs::DirEntry> = Vec::new();
    for res in rd {
        let entry = res.map_err(|e| {
            AppError::Validation(format!("遍历目录失败 {}: {e}", local_dir.display()))
        })?;
        entries.push(entry);
    }
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_ignore_junk_name(&name) {
            continue;
        }
        let meta = std::fs::symlink_metadata(&path).map_err(|e| {
            AppError::Validation(format!("读取文件属性失败 {}: {e}", path.display()))
        })?;
        if meta.file_type().is_symlink() {
            plan.skipped.push(format!("跳过符号链接: {}", path.display()));
            continue;
        }
        if meta.is_dir() {
            let child_remote = format!("{}/{name}", remote_dir.trim_end_matches('/'));
            if seen_dirs.insert(child_remote.clone()) {
                plan.directories.push(RemoteMkdirOp {
                    parent: remote_dir.to_string(),
                    name: name.clone(),
                    full_remote_dir: child_remote.clone(),
                });
            }
            let child_rel = format!("{rel_prefix}/{name}");
            walk_dir_for_upload(&path, &child_remote, &child_rel, depth + 1, seen_dirs, plan)?;
        } else if meta.is_file() {
            if plan.files.len() >= MAX_UPLOAD_FILES_PER_BATCH {
                return Err(AppError::Validation(format!(
                    "单次最多批量上传 {MAX_UPLOAD_FILES_PER_BATCH} 个文件，请分批拖入"
                )));
            }
            plan.files.push(PlannedUploadFile {
                local_path: path,
                display_name: format!("{rel_prefix}/{name}"),
                dest_dir: remote_dir.to_string(),
            });
        }
    }
    Ok(())
}

/// Build a deterministic top-down directory creation and file upload plan from local files/folders.
pub fn build_upload_plan<P: AsRef<Path>>(
    input_paths: &[P],
    remote_base_dir: &str,
) -> AppResult<UploadPlan> {
    let base = remote_base_dir.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Validation("目标上传目录不能为空".into()));
    }
    let mut plan = UploadPlan {
        directories: Vec::new(),
        files: Vec::new(),
        skipped: Vec::new(),
    };
    let mut seen_dirs = BTreeSet::new();

    for raw in input_paths {
        let path = raw.as_ref();
        let meta = std::fs::symlink_metadata(path).map_err(|e| {
            AppError::Validation(format!("本地路径不可访问 {}: {e}", path.display()))
        })?;
        if meta.file_type().is_symlink() {
            plan.skipped.push(format!("跳过符号链接: {}", path.display()));
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| AppError::Validation(format!("无效文件名: {}", path.display())))?
            .to_string();
        if meta.is_dir() {
            let child_remote = format!("{base}/{name}");
            if seen_dirs.insert(child_remote.clone()) {
                plan.directories.push(RemoteMkdirOp {
                    parent: base.to_string(),
                    name: name.clone(),
                    full_remote_dir: child_remote.clone(),
                });
            }
            walk_dir_for_upload(path, &child_remote, &name, 1, &mut seen_dirs, &mut plan)?;
        } else if meta.is_file() {
            if plan.files.len() >= MAX_UPLOAD_FILES_PER_BATCH {
                return Err(AppError::Validation(format!(
                    "单次最多批量上传 {MAX_UPLOAD_FILES_PER_BATCH} 个文件，请分批拖入"
                )));
            }
            plan.files.push(PlannedUploadFile {
                local_path: path.to_path_buf(),
                display_name: name,
                dest_dir: base.to_string(),
            });
        } else {
            plan.skipped.push(format!("跳过非常规文件: {}", path.display()));
        }
    }

    Ok(plan)
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
            .run_cli_with_timeout(&["file", "upload", "--params", &params, "--yes"], Some(parent), Some(300))
            .await
    }

    /// Upload any mix of local files and folders into `dest_dir`, creating remote subdirectories
    /// as needed (reusing matching existing subdirectories to prevent unwanted duplicates).
    pub async fn upload_paths<F>(
        &self,
        local_paths: &[String],
        dest_dir: &str,
        rename_on_conflict: bool,
        batch_id: &str,
        mut on_progress: F,
    ) -> AppResult<UploadBatchSummary>
    where
        F: FnMut(UploadBatchProgress),
    {
        let plan = build_upload_plan(local_paths, dest_dir)?;
        let mut resolved_dirs: HashMap<String, String> = HashMap::new();
        let mut existing_children: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut created_dirs = 0usize;

        for op in &plan.directories {
            let actual_parent = resolved_dirs
                .get(&op.parent)
                .cloned()
                .unwrap_or_else(|| op.parent.clone());
            if !existing_children.contains_key(&actual_parent) {
                let children = match self.file_list(&actual_parent, 0, 200).await {
                    Ok(v) => extract_dir_children(&v, &actual_parent),
                    Err(_) => HashMap::new(),
                };
                existing_children.insert(actual_parent.clone(), children);
            }
            if let Some(existing_path) = existing_children
                .get(&actual_parent)
                .and_then(|m| m.get(&op.name))
                .cloned()
            {
                resolved_dirs.insert(op.full_remote_dir.clone(), existing_path);
                continue;
            }

            let created = self.mkdir(&actual_parent, &op.name).await?;
            let actual_child = pick_str(&created, &["path", "file_path", "full_path"])
                .unwrap_or_else(|| format!("{}/{}", actual_parent.trim_end_matches('/'), op.name));
            existing_children
                .entry(actual_parent)
                .or_default()
                .insert(op.name.clone(), actual_child.clone());
            resolved_dirs.insert(op.full_remote_dir.clone(), actual_child);
            created_dirs += 1;
        }

        let total = plan.files.len();
        let mut succeeded = 0usize;
        let mut failed = 0usize;

        for (idx, file) in plan.files.iter().enumerate() {
            let target_dir = resolved_dirs
                .get(&file.dest_dir)
                .cloned()
                .unwrap_or_else(|| file.dest_dir.clone());
            let job_id = format!("{batch_id}_{idx}");
            let local_str = file.local_path.to_string_lossy().into_owned();

            on_progress(UploadBatchProgress {
                batch_id: batch_id.to_string(),
                job_id: job_id.clone(),
                name: file.display_name.clone(),
                local_path: local_str.clone(),
                dest_dir: target_dir.clone(),
                status: "uploading".into(),
                error: None,
                current: idx + 1,
                total,
            });

            match self.upload_file(&local_str, &target_dir, rename_on_conflict).await {
                Ok(_) => {
                    succeeded += 1;
                    on_progress(UploadBatchProgress {
                        batch_id: batch_id.to_string(),
                        job_id,
                        name: file.display_name.clone(),
                        local_path: local_str,
                        dest_dir: target_dir,
                        status: "done".into(),
                        error: None,
                        current: idx + 1,
                        total,
                    });
                }
                Err(e) => {
                    failed += 1;
                    on_progress(UploadBatchProgress {
                        batch_id: batch_id.to_string(),
                        job_id,
                        name: file.display_name.clone(),
                        local_path: local_str,
                        dest_dir: target_dir,
                        status: "error".into(),
                        error: Some(e.to_string()),
                        current: idx + 1,
                        total,
                    });
                }
            }
        }

        Ok(UploadBatchSummary {
            batch_id: batch_id.to_string(),
            total_files: total,
            succeeded,
            failed,
            created_dirs,
            skipped_count: plan.skipped.len(),
        })
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
            .run_cli_with_timeout(
                &["file", "download", "--params", &params, "--yes"],
                Some(parent),
                Some(300),
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

    // --- NAS Downloader Dashboard (`download tasks` / `download manage` / `download control`) ---

    pub async fn download_tasks(
        &self,
        task_type: &str,
        start: u32,
        size: u32,
    ) -> AppResult<Value> {
        let clamped_size = size.clamp(1, 1000);
        let norm_type = normalize_download_task_type(task_type);

        let p_ctrl = serde_json::to_string(&json!({
            "action": "tasks/details",
            "task_type": norm_type,
            "start": start,
            "size": clamped_size
        }))?;
        let p_list = serde_json::to_string(&json!({
            "start": start,
            "num": clamped_size
        }))?;

        let a_ctrl = ["download", "control", "--params", p_ctrl.as_str()];
        let a_list = ["download", "tasks", "--params", p_list.as_str()];
        let (ctrl_res, list_res) = tokio::join!(
            self.provider.run_cli(&a_ctrl, None),
            self.provider.run_cli(&a_list, None),
        );

        match (ctrl_res, list_res) {
            (Ok(ctrl), Ok(list)) => Ok(json!({
                "control": ctrl,
                "tasks": list,
            })),
            (Ok(ctrl), Err(e)) => Ok(json!({
                "control": ctrl,
                "list_error": e.to_string(),
            })),
            (Err(e), Ok(list)) => Ok(json!({
                "tasks": list,
                "control_error": e.to_string(),
            })),
            (Err(_), Err(e2)) => Err(e2),
        }
    }

    pub async fn download_dirs(&self) -> AppResult<Value> {
        let params = serde_json::to_string(&json!({ "action": "downloaddir" }))?;
        self.provider
            .run_cli(&["download", "control", "--params", &params], None)
            .await
    }

    pub async fn download_add(&self, uri: &str, dir: Option<&str>) -> AppResult<Value> {
        let clean_uri = validate_download_uri(uri)?;
        let mut obj = json!({
            "action": "add",
            "uri": clean_uri
        });
        if let Some(d) = dir.map(str::trim).filter(|s| !s.is_empty()) {
            obj["dir"] = json!(d);
        }
        let params = serde_json::to_string(&obj)?;
        self.provider
            .run_cli_with_timeout(
                &[
                    "download",
                    "manage",
                    "--params",
                    &params,
                    "--yes",
                    "--allow-nas-fetch",
                ],
                None,
                Some(60),
            )
            .await
    }

    pub async fn download_manage_action(
        &self,
        action: &str,
        ids: Vec<Value>,
    ) -> AppResult<Value> {
        let params = build_download_manage_action_params(action, &ids)?;
        let params_str = serde_json::to_string(&params)?;
        self.provider
            .run_cli(&["download", "manage", "--params", &params_str, "--yes"], None)
            .await
    }
}

pub fn normalize_download_task_type(task_type: &str) -> &'static str {
    match task_type.trim().to_ascii_lowercase().as_str() {
        "loading" | "downloading" | "active" => "loading",
        "complete" | "completed" | "done" => "complete",
        _ => "all",
    }
}

pub fn validate_download_uri(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("请输入下载链接（HTTP/HTTPS/Magnet/ed2k）".into()));
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("magnet:")
        || lower.starts_with("ed2k://")
        || lower.starts_with("ftp://"))
    {
        return Err(AppError::Validation(
            "仅支持 HTTP(S)、Magnet 磁力链、ed2k 或 FTP 下载链接".into(),
        ));
    }
    Ok(trimmed.to_string())
}

pub fn build_download_manage_action_params(action: &str, ids: &[Value]) -> AppResult<Value> {
    if !matches!(action, "start" | "stop" | "delete") {
        return Err(AppError::Validation(format!(
            "不支持的下载任务控制动作: {action}"
        )));
    }
    if ids.is_empty() {
        return Err(AppError::Validation("请至少选择一个下载任务 ID".into()));
    }
    Ok(json!({
        "action": action,
        "ids": ids
    }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn build_upload_plan_handles_files_folders_and_ignores_os_junk() {
        let dir = tempdir().unwrap();
        let top_file = dir.path().join("notes.txt");
        fs::write(&top_file, "hello").unwrap();

        let sub_dir = dir.path().join("Photos");
        let nested = sub_dir.join("2026");
        let empty = sub_dir.join("Empty");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&empty).unwrap();
        fs::write(sub_dir.join(".DS_Store"), "junk").unwrap();
        fs::write(sub_dir.join("cover.jpg"), "img").unwrap();
        fs::write(nested.join("trip.png"), "png").unwrap();

        let plan = build_upload_plan(&[top_file.clone(), sub_dir.clone()], "/pool/my/data/downloads/").unwrap();
        assert_eq!(
            plan.directories,
            vec![
                RemoteMkdirOp {
                    parent: "/pool/my/data/downloads".into(),
                    name: "Photos".into(),
                    full_remote_dir: "/pool/my/data/downloads/Photos".into(),
                },
                RemoteMkdirOp {
                    parent: "/pool/my/data/downloads/Photos".into(),
                    name: "2026".into(),
                    full_remote_dir: "/pool/my/data/downloads/Photos/2026".into(),
                },
                RemoteMkdirOp {
                    parent: "/pool/my/data/downloads/Photos".into(),
                    name: "Empty".into(),
                    full_remote_dir: "/pool/my/data/downloads/Photos/Empty".into(),
                },
            ]
        );
        let rels: Vec<&str> = plan.files.iter().map(|f| f.display_name.as_str()).collect();
        assert_eq!(rels, vec!["notes.txt", "Photos/2026/trip.png", "Photos/cover.jpg"]);
        assert_eq!(plan.files[1].dest_dir, "/pool/my/data/downloads/Photos/2026");
        assert_eq!(plan.files[2].dest_dir, "/pool/my/data/downloads/Photos");
    }

    #[test]
    fn extract_dir_children_strictly_filters_string_zero_and_one() {
        let payload = json!({
            "list": [
                { "name": "Photos", "path": "/p/downloads/Photos", "is_dir": "1" },
                { "name": "movie.mp4", "path": "/p/downloads/movie.mp4", "is_dir": "0" },
                { "name": "Logs", "is_dir": true },
                { "name": "readme.txt", "is_dir": false }
            ]
        });
        let map = extract_dir_children(&payload, "/p/downloads");
        assert_eq!(map.get("Photos").map(String::as_str), Some("/p/downloads/Photos"));
        assert_eq!(map.get("Logs").map(String::as_str), Some("/p/downloads/Logs"));
        assert!(!map.contains_key("movie.mp4"));
        assert!(!map.contains_key("readme.txt"));
    }

    #[test]
    fn download_validators_enforce_uri_and_manage_schema() {
        assert_eq!(
            validate_download_uri("  magnet:?xt=urn:btih:12345  ").unwrap(),
            "magnet:?xt=urn:btih:12345"
        );
        assert!(validate_download_uri("/local/file.iso").is_err());
        assert_eq!(normalize_download_task_type("downloading"), "loading");
        assert_eq!(normalize_download_task_type("DONE"), "complete");
        assert_eq!(normalize_download_task_type("unknown"), "all");

        let p = build_download_manage_action_params("stop", &[json!(101)]).unwrap();
        assert_eq!(p["action"], "stop");
        assert_eq!(p["ids"], json!([101]));
        assert!(build_download_manage_action_params("wipe", &[json!(1)]).is_err());
        assert!(build_download_manage_action_params("start", &[]).is_err());
    }
}
