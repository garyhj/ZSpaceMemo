use crate::error::{AppError, AppResult};
use crate::models::TaskAttachment;
use crate::provider::{
    AuthStatus, NoteCategory, NoteHistoryEntry, NoteSummary, NotebookProvider, RawNote,
};
use crate::storage::AppSettings;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// Connection & timeout policy passed to `zspace-cli` global options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConnectionConfig {
    pub mode: String, // "auto" | "cloud" | "lan"
    pub host: Option<String>,
    pub allow_insecure_http: bool,
    pub timeout_secs: u64,
}

impl Default for CliConnectionConfig {
    fn default() -> Self {
        Self {
            mode: "auto".into(),
            host: None,
            allow_insecure_http: false,
            timeout_secs: 30,
        }
    }
}

impl From<&AppSettings> for CliConnectionConfig {
    fn from(s: &AppSettings) -> Self {
        Self {
            mode: s.connection_mode.clone(),
            host: s.lan_host.clone(),
            allow_insecure_http: s.allow_insecure_http,
            timeout_secs: s.cli_timeout_secs,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NasDoctorReport {
    pub ok: bool,
    pub configured_mode: String,
    pub configured_host: Option<String>,
    pub effective_mode: Option<String>,
    pub effective_host: Option<String>,
    pub latency_ms: u64,
    pub details: Value,
    pub error: Option<String>,
}

/// Build global options placed strictly BEFORE the `zspace-cli` subcommand (`file`, `system`, etc.).
pub fn build_global_cli_args(
    profile: &str,
    cfg: &CliConnectionConfig,
    clear_host: bool,
    timeout_override: Option<u64>,
    local_root: Option<&Path>,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("--profile"), OsString::from(profile)];

    let mode = match cfg.mode.as_str() {
        "lan" | "cloud" | "auto" => cfg.mode.as_str(),
        _ => "auto",
    };
    args.push(OsString::from("--mode"));
    args.push(OsString::from(mode));

    let effective_timeout = timeout_override
        .map(|t| t.max(cfg.timeout_secs))
        .unwrap_or(cfg.timeout_secs)
        .clamp(10, 1800);
    args.push(OsString::from("--timeout"));
    args.push(OsString::from(effective_timeout.to_string()));

    if clear_host {
        args.push(OsString::from("--clear-host"));
    } else if mode == "lan" {
        if let Some(host) = cfg.host.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            args.push(OsString::from("--host"));
            args.push(OsString::from(host));
            if host.to_ascii_lowercase().starts_with("http://") && cfg.allow_insecure_http {
                args.push(OsString::from("--allow-insecure-http"));
            }
        }
    }

    if let Some(root) = local_root {
        args.push(OsString::from("--local-root"));
        args.push(root.as_os_str().to_os_string());
    }
    args
}

/// Active interactive OAuth2 login transaction (valid for 180s).
/// Holds `stdout` open so the child process does not hit a broken pipe when printing the final JSON.
pub struct PendingOAuthLogin {
    pub url: String,
    pub expires_in: u64,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    child: Child,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthStartInfo {
    pub url: String,
    pub expires_in: u64,
}

/// Official `zspace-cli` (zspace-nas-agent-toolkit) NotebookProvider implementation.
pub struct OfficialCliNotebookProvider {
    cli_path: PathBuf,
    cli_home: PathBuf,
    profile: String,
    pending_login: Mutex<Option<PendingOAuthLogin>>,
    connection: RwLock<CliConnectionConfig>,
    pending_clear_host: AtomicBool,
}

impl OfficialCliNotebookProvider {
    pub fn new(cli_path: PathBuf, cli_home: PathBuf, profile: impl Into<String>) -> Self {
        Self {
            cli_path,
            cli_home,
            profile: profile.into(),
            pending_login: Mutex::new(None),
            connection: RwLock::new(CliConnectionConfig::default()),
            pending_clear_host: AtomicBool::new(false),
        }
    }

    pub fn set_connection_config(&self, cfg: CliConnectionConfig, clear_persisted_host: bool) {
        if let Ok(mut guard) = self.connection.write() {
            *guard = cfg;
        }
        if clear_persisted_host {
            self.pending_clear_host.store(true, Ordering::Release);
        }
    }

    pub fn connection_config(&self) -> CliConnectionConfig {
        self.connection
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub async fn flush_clear_host(&self) {
        if self.pending_clear_host.load(Ordering::Acquire) {
            let _ = self.run_json(&["status"]).await;
        }
    }

    fn build_command(
        &self,
        timeout_override: Option<u64>,
        local_root: Option<&Path>,
        allow_clear_host: bool,
    ) -> (Command, bool, u64) {
        let mut cmd = Command::new(&self.cli_path);
        cmd.env("ZSPACE_CLI_HOME", &self.cli_home);
        cmd.kill_on_drop(true);
        let cfg = self.connection_config();
        let effective_timeout = cfg.timeout_secs.max(timeout_override.unwrap_or(0)).max(10);
        let clear_host = if allow_clear_host {
            self.pending_clear_host.swap(false, Ordering::AcqRel)
        } else {
            false
        };
        let global_args = build_global_cli_args(
            &self.profile,
            &cfg,
            clear_host,
            timeout_override,
            local_root,
        );
        cmd.args(global_args);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        (cmd, clear_host, effective_timeout)
    }

    fn base_command(&self) -> Command {
        self.build_command(None, None, false).0
    }

    async fn run_json(&self, args: &[&str]) -> AppResult<Value> {
        self.run_cli_raw(args, None, None).await
    }

    /// Execute any official `zspace-cli` subcommand and return its full `{ok, data}` JSON.
    pub async fn run_cli(&self, args: &[&str], local_root: Option<&Path>) -> AppResult<Value> {
        self.run_cli_with_timeout(args, local_root, None).await
    }

    /// Execute a `zspace-cli` subcommand with an optional minimum timeout override (e.g., 300s for uploads).
    pub async fn run_cli_with_timeout(
        &self,
        args: &[&str],
        local_root: Option<&Path>,
        timeout_secs: Option<u64>,
    ) -> AppResult<Value> {
        let val = self.run_cli_raw(args, local_root, timeout_secs).await?;
        Ok(val.get("data").cloned().unwrap_or(val))
    }

    /// Run `zspace-cli doctor` to diagnose credentials, local security storage, and NAS connectivity.
    pub async fn doctor(&self) -> NasDoctorReport {
        let cfg = self.connection_config();
        let t0 = Instant::now();
        let diag = self.run_cli_raw(&["doctor"], None, None).await;
        let latency_ms = t0.elapsed().as_millis() as u64;
        let st = self.auth_status().await.ok();

        match diag {
            Ok(val) => NasDoctorReport {
                ok: true,
                configured_mode: cfg.mode,
                configured_host: cfg.host,
                effective_mode: st.as_ref().and_then(|s| s.mode.clone()),
                effective_host: st.as_ref().and_then(|s| s.host.clone()),
                latency_ms,
                details: val.get("data").cloned().unwrap_or(val),
                error: None,
            },
            Err(e) => NasDoctorReport {
                ok: false,
                configured_mode: cfg.mode,
                configured_host: cfg.host,
                effective_mode: st.as_ref().and_then(|s| s.mode.clone()),
                effective_host: st.as_ref().and_then(|s| s.host.clone()),
                latency_ms,
                details: Value::Null,
                error: Some(e.to_string()),
            },
        }
    }

    async fn run_cli_raw(
        &self,
        args: &[&str],
        local_root: Option<&Path>,
        timeout_secs: Option<u64>,
    ) -> AppResult<Value> {
        let (mut cmd, cleared, effective_timeout) =
            self.build_command(timeout_secs, local_root, true);
        let wait_secs = effective_timeout.saturating_add(15);
        let output = match tokio::time::timeout(
            std::time::Duration::from_secs(wait_secs),
            cmd.args(args).output(),
        )
        .await
        {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                if cleared {
                    self.pending_clear_host.store(true, Ordering::Release);
                }
                return Err(AppError::NasUnavailable(format!(
                    "无法启动 zspace-cli: {e}"
                )));
            }
            Err(_) => {
                if cleared {
                    self.pending_clear_host.store(true, Ordering::Release);
                }
                return Err(AppError::NasUnavailable(format!(
                    "zspace-cli 执行超时（超过 {wait_secs} 秒）"
                )));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        for raw in [&stdout, &stderr] {
            if raw.is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<Value>(raw) {
                if val.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                    return Ok(val);
                }
                if cleared {
                    self.pending_clear_host.store(true, Ordering::Release);
                }
                let code = val
                    .pointer("/error/code")
                    .and_then(|v| v.as_str())
                    .unwrap_or("UNKNOWN");
                let msg = val
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&stderr);
                if code.contains("OAUTH") || code.contains("AUTH") || code.contains("CREDENTIAL") {
                    return Err(AppError::NasAuthRequired(format!("{code}: {msg}")));
                }
                return Err(AppError::NasUnavailable(format!("{code}: {msg}")));
            }
        }

        if cleared {
            self.pending_clear_host.store(true, Ordering::Release);
        }

        if !output.status.success() {
            return Err(AppError::NasUnavailable(format!(
                "zspace-cli 执行失败 (code {:?}): {}",
                output.status.code(),
                if !stderr.is_empty() { stderr } else { stdout }
            )));
        }

        let preview: String = stdout.chars().take(200).collect();
        Err(AppError::Internal(format!(
            "zspace-cli 返回非 JSON 输出: {preview}"
        )))
    }

    async fn run_file_notes(&self, params: Value, write: bool) -> AppResult<Value> {
        let params_str = serde_json::to_string(&params)?;
        let mut args = vec!["file", "notes", "--params", &params_str];
        if write {
            args.push("--yes");
        }
        self.run_json(&args).await
    }

    /// Start official OAuth2 authorization flow (`login --no-open --auth-code-stdin`).
    /// Keeps the CLI process and its stdout pipe alive waiting for the one-time auth code on stdin.
    pub async fn start_oauth_login(&self) -> AppResult<OAuthStartInfo> {
        let _ = std::fs::create_dir_all(&self.cli_home);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(&self.cli_home, std::fs::Permissions::from_mode(0o700));
        }

        let mut guard = self.pending_login.lock().await;
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill().await;
        }

        let mut child = self
            .base_command()
            .args(["login", "--no-open", "--auth-code-stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::NasAuthFailed(format!("无法启动授权进程: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Internal("无法获取授权进程 stdin".into()))?;
        let stdout_pipe = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("无法获取授权进程 stdout".into()))?;

        let mut reader = BufReader::new(stdout_pipe);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| AppError::NasAuthFailed(format!("读取授权输出失败: {e}")))?;
            if n == 0 {
                break;
            }
            if let Ok(val) = serde_json::from_str::<Value>(line.trim()) {
                if val.get("event").and_then(|v| v.as_str()) == Some("oauth_authorization") {
                    let url = val
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let expires_in = val
                        .get("expires_in")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(180);
                    *guard = Some(PendingOAuthLogin {
                        url: url.clone(),
                        expires_in,
                        stdin,
                        stdout: reader,
                        child,
                    });
                    return Ok(OAuthStartInfo { url, expires_in });
                }
            }
        }

        let _ = child.kill().await;
        Err(AppError::NasAuthFailed(
            "授权进程未返回 oauth_authorization 链接".into(),
        ))
    }

    /// Submit the user's one-time authorization code directly to the waiting CLI stdin
    /// (never logged, echoed, or written to disk).
    pub async fn submit_oauth_code(&self, code: &str) -> AppResult<AuthStatus> {
        let mut pending = {
            let mut guard = self.pending_login.lock().await;
            guard.take().ok_or_else(|| {
                AppError::NasAuthFailed("当前没有等待中的授权事务，请重新获取授权链接".into())
            })?
        };

        let trimmed = code.trim();
        if trimmed.is_empty() {
            let _ = pending.child.kill().await;
            return Err(AppError::Validation("授权码不能为空".into()));
        }

        pending
            .stdin
            .write_all(format!("{trimmed}\n").as_bytes())
            .await
            .map_err(|e| AppError::NasAuthFailed(format!("写入授权码失败: {e}")))?;
        pending
            .stdin
            .flush()
            .await
            .map_err(|e| AppError::NasAuthFailed(format!("刷新授权码缓冲失败: {e}")))?;
        drop(pending.stdin);

        // Drain stdout concurrently while waiting for process exit so the pipe never closes early.
        let mut stdout_buf = Vec::new();
        let (read_res, wait_res) = tokio::join!(
            pending.stdout.read_to_end(&mut stdout_buf),
            pending.child.wait_with_output()
        );
        let _ = read_res;
        let output =
            wait_res.map_err(|e| AppError::NasAuthFailed(format!("等待授权结果失败: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&stdout_buf).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            return Err(AppError::NasAuthFailed(format!("授权失败: {detail}")));
        }

        self.auth_status().await
    }

    pub async fn logout(&self) -> AppResult<()> {
        let _ = self.run_json(&["logout"]).await?;
        Ok(())
    }
}

fn parse_raw_note(v: &Value) -> AppResult<RawNote> {
    Ok(RawNote {
        id: v
            .get("id")
            .and_then(|x| x.as_i64())
            .ok_or_else(|| AppError::Internal("NAS 返回的笔记缺少 id 字段".into()))?,
        title: v
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        body: v
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        classify_id: v.get("classify_id").and_then(|x| x.as_i64()).unwrap_or(0),
        in_brief: v
            .get("in_brief")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        pin_flag: v.get("pin_flag").and_then(|x| x.as_i64()).unwrap_or(0),
        length: v.get("length").and_then(|x| x.as_i64()).unwrap_or(0),
        updated_at: v.get("updated_at").and_then(|x| x.as_i64()).unwrap_or(0),
        created_at: v.get("created_at").and_then(|x| x.as_i64()).unwrap_or(0),
    })
}

#[async_trait]
impl NotebookProvider for OfficialCliNotebookProvider {
    async fn auth_status(&self) -> AppResult<AuthStatus> {
        let val = self.run_json(&["status"]).await?;
        let data = val.get("data").unwrap_or(&Value::Null);
        Ok(AuthStatus {
            logged_in: data
                .get("logged_in")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            nas_id: data
                .get("nas_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            expires_at: data.get("expires_at").and_then(|v| v.as_i64()),
            profile: self.profile.clone(),
            mode: data
                .get("mode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            host: data
                .get("host")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        })
    }

    async fn list_categories(&self) -> AppResult<Vec<NoteCategory>> {
        let val = self
            .run_file_notes(json!({"action": "all_classes", "location": "2"}), false)
            .await?;
        let list = val
            .pointer("/data/list")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for item in list {
            if let (Some(id), Some(name)) = (
                item.get("id").and_then(|v| v.as_i64()),
                item.get("name").and_then(|v| v.as_str()),
            ) {
                out.push(NoteCategory {
                    id,
                    name: name.to_string(),
                    parent_id: item.get("parent_id").and_then(|v| v.as_i64()).unwrap_or(0),
                });
            }
        }
        Ok(out)
    }

    async fn create_category(&self, name: &str) -> AppResult<i64> {
        let val = self
            .run_file_notes(
                json!({"action": "class_create", "location": "2", "name": name}),
                true,
            )
            .await?;
        val.get("data")
            .and_then(|v| v.as_i64().or_else(|| v.get("id").and_then(|x| x.as_i64())))
            .ok_or_else(|| AppError::Internal("class_create 未返回分类 ID".into()))
    }

    async fn list_notes(
        &self,
        classify_id: i64,
        start: u32,
        num: u32,
    ) -> AppResult<Vec<NoteSummary>> {
        let val = self
            .run_file_notes(
                json!({
                    "action": "list",
                    "location": "2",
                    "classify_id": classify_id,
                    "start": start,
                    "num": num,
                    "sortby": 1
                }),
                false,
            )
            .await?;
        let list = val
            .pointer("/data/list")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for item in list {
            if let Some(id) = item.get("id").and_then(|v| v.as_i64()) {
                out.push(NoteSummary {
                    id,
                    title: item
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    classify_id: item
                        .get("classify_id")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(classify_id),
                    in_brief: item
                        .get("in_brief")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    pin_flag: item.get("pin_flag").and_then(|v| v.as_i64()).unwrap_or(0),
                    length: item.get("length").and_then(|v| v.as_i64()).unwrap_or(0),
                    updated_at: item.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0),
                    created_at: item.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
                });
            }
        }
        Ok(out)
    }

    async fn get_note(&self, id: i64) -> AppResult<RawNote> {
        let val = match self
            .run_file_notes(json!({"action": "info", "location": "2", "id": id}), false)
            .await
        {
            Ok(v) => v,
            Err(AppError::NasUnavailable(msg)) if is_note_not_found_msg(&msg) => {
                return Err(AppError::TaskNotFound(id));
            }
            Err(e) => return Err(e),
        };
        let data = val.get("data").ok_or(AppError::TaskNotFound(id))?;
        parse_raw_note(data)
    }

    async fn create_note(
        &self,
        title: &str,
        body: &str,
        classify_id: i64,
        in_brief: &str,
    ) -> AppResult<RawNote> {
        let val = self
            .run_file_notes(
                json!({
                    "action": "create",
                    "location": "2",
                    "title": title,
                    "body": body,
                    "classify_id": classify_id,
                    "in_brief": in_brief
                }),
                true,
            )
            .await?;
        let data = val
            .get("data")
            .ok_or_else(|| AppError::Internal("create 未返回笔记对象".into()))?;
        parse_raw_note(data)
    }

    async fn update_note(&self, id: i64, title: &str, body: &str, in_brief: &str) -> AppResult<()> {
        let _ = self
            .run_file_notes(
                json!({
                    "action": "update",
                    "location": "2",
                    "id": id,
                    "title": title,
                    "body": body,
                    "in_brief": in_brief
                }),
                true,
            )
            .await?;
        Ok(())
    }

    async fn pin_note(&self, id: i64, pinned: bool) -> AppResult<()> {
        let _ = self
            .run_file_notes(
                json!({
                    "action": "pin",
                    "location": "2",
                    "id": id,
                    "cancel": if pinned { 0 } else { 1 }
                }),
                true,
            )
            .await?;
        Ok(())
    }

    async fn delete_note(&self, id: i64) -> AppResult<()> {
        let _ = self
            .run_file_notes(
                json!({
                    "action": "delete",
                    "location": "2",
                    "ids": [id.to_string()]
                }),
                true,
            )
            .await?;
        Ok(())
    }

    async fn list_history(&self, note_id: i64) -> AppResult<Vec<NoteHistoryEntry>> {
        let val = self
            .run_file_notes(
                json!({
                    "action": "history",
                    "location": "2",
                    "notepad_id": note_id,
                    "start": 0,
                    "num": 5
                }),
                false,
            )
            .await?;
        let list = val
            .pointer("/data/list")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for item in list {
            if let Some(hid) = item.get("id").and_then(|v| v.as_i64()) {
                let hinfo = self
                    .run_file_notes(
                        json!({"action": "history_info", "location": "2", "id": hid}),
                        false,
                    )
                    .await
                    .ok();
                let body = hinfo
                    .as_ref()
                    .and_then(|h| {
                        h.pointer("/data/body")
                            .or_else(|| h.pointer("/data/content"))
                            .and_then(|s| s.as_str())
                    })
                    .map(|s| s.to_string());
                out.push(NoteHistoryEntry {
                    id: hid,
                    body,
                    updated_at: item.get("updated_at").and_then(|v| v.as_i64()),
                });
            }
        }
        Ok(out)
    }

    async fn upload_note_attachment(
        &self,
        note_id: i64,
        local_path: &Path,
    ) -> AppResult<TaskAttachment> {
        let meta = std::fs::symlink_metadata(local_path).map_err(|e| {
            AppError::Validation(format!("附件路径不可访问 {}: {e}", local_path.display()))
        })?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(AppError::Validation(format!(
                "仅支持上传本地常规文件作为待办附件：{}",
                local_path.display()
            )));
        }
        let (parent, file_name) =
            split_local_root_and_name(local_path, "无法解析附件所在本地目录", "无效附件文件名")?;
        let size = Some(meta.len());

        let params_str =
            serde_json::to_string(&build_attachment_upload_params(note_id, &file_name))?;
        let val = self
            .run_cli_with_timeout(
                &["file", "notes", "--params", &params_str, "--yes"],
                Some(&parent),
                Some(300),
            )
            .await?;

        let (file_id, resource_path, safe_dir) = extract_uploaded_attachment_fields(&val)
            .ok_or_else(|| {
                AppError::Internal(
                    "极空间返回结果缺少附件 file_id，请检查笔记后重试（避免重复上传）".into(),
                )
            })?;

        Ok(TaskAttachment {
            file_id,
            name: file_name,
            size,
            resource_path,
            safe_dir,
            uploaded_at: Some(chrono::Utc::now().to_rfc3339()),
        })
    }

    async fn download_note_attachment(
        &self,
        attachment: &TaskAttachment,
        local_dest: &Path,
    ) -> AppResult<()> {
        let (parent, file_name) =
            split_local_root_and_name(local_dest, "无法解析附件保存目录", "无效附件保存文件名")?;
        if !parent.exists() {
            std::fs::create_dir_all(&parent)
                .map_err(|e| AppError::Storage(format!("创建保存目录失败: {e}")))?;
        }
        let params_str = serde_json::to_string(&build_attachment_download_params(
            attachment, &file_name, true,
        ))?;
        self.run_cli_with_timeout(
            &["file", "notes", "--params", &params_str, "--yes"],
            Some(&parent),
            Some(300),
        )
        .await?;
        Ok(())
    }
}

fn is_note_not_found_msg(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("not_found")
        || lower.contains("not found")
        || lower.contains("no such")
        || msg.contains("不存在")
        || msg.contains("已删除")
        || msg.contains("找不到")
}

/// Split a local file path into non-empty `--local-root` directory and basename.
/// Resolves bare relative paths (e.g. `"foo.txt"`) whose `parent()` is `""` to `"."`.
pub(crate) fn split_local_root_and_name(
    path: &Path,
    dir_err: &str,
    name_err: &str,
) -> AppResult<(PathBuf, String)> {
    let parent_raw = path
        .parent()
        .ok_or_else(|| AppError::Validation(dir_err.to_string()))?;
    let parent = if parent_raw.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        parent_raw.to_path_buf()
    };
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Validation(name_err.to_string()))?
        .to_string();
    Ok((parent, name))
}

/// Strictly match the whitelisted `attachment_upload` schema in `zspace-cli`.
pub fn build_attachment_upload_params(note_id: i64, file_name: &str) -> Value {
    json!({
        "action": "attachment_upload",
        "location": "2",
        "id": note_id,
        "local_path": file_name
    })
}

/// Strictly match the whitelisted `attachment_download` schema in `zspace-cli`.
pub fn build_attachment_download_params(
    attachment: &TaskAttachment,
    file_name: &str,
    overwrite: bool,
) -> Value {
    let mut obj = json!({
        "action": "attachment_download",
        "location": "2",
        "file_id": attachment.file_id,
        "local_path": file_name,
        "overwrite": overwrite
    });
    if let Some(sd) = attachment
        .safe_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        obj["safe_dir"] = json!(sd);
    }
    obj
}

fn pick_json_id_or_str(obj: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            if let Some(s) = v.as_str() {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            } else if let Some(n) = v.as_i64() {
                return Some(n.to_string());
            } else if let Some(n) = v.as_u64() {
                return Some(n.to_string());
            }
        }
    }
    None
}

pub fn extract_uploaded_attachment_fields(
    val: &Value,
) -> Option<(String, Option<String>, Option<String>)> {
    let mut candidates = vec![val];
    if let Some(d) = val.get("data") {
        candidates.push(d);
    }
    if let Some(f) = val.get("file") {
        candidates.push(f);
    }
    if let Some(d) = val.pointer("/data/file") {
        candidates.push(d);
    }
    let mut file_id = None;
    let mut resource_path = None;
    let mut safe_dir = None;
    for obj in candidates {
        if file_id.is_none() {
            file_id = pick_json_id_or_str(obj, &["file_id", "fileId", "id", "fid"]);
        }
        if resource_path.is_none() {
            resource_path = pick_json_id_or_str(obj, &["resource_path", "resourcePath", "path"]);
        }
        if safe_dir.is_none() {
            safe_dir = pick_json_id_or_str(obj, &["safe_dir", "safeDir", "dir"]);
        }
    }
    file_id.map(|fid| (fid, resource_path, safe_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_strings(v: Vec<OsString>) -> Vec<String> {
        v.into_iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn global_cli_args_cover_auto_lan_http_and_clear_host() {
        let auto_cfg = CliConnectionConfig::default();
        assert_eq!(
            to_strings(build_global_cli_args(
                "zspace-memo",
                &auto_cfg,
                false,
                None,
                None
            )),
            vec![
                "--profile",
                "zspace-memo",
                "--mode",
                "auto",
                "--timeout",
                "30"
            ]
        );

        let lan_http = CliConnectionConfig {
            mode: "lan".into(),
            host: Some("http://192.168.1.2:5055".into()),
            allow_insecure_http: true,
            timeout_secs: 45,
        };
        assert_eq!(
            to_strings(build_global_cli_args(
                "zspace-memo",
                &lan_http,
                false,
                Some(300),
                Some(Path::new("/tmp/root")),
            )),
            vec![
                "--profile",
                "zspace-memo",
                "--mode",
                "lan",
                "--timeout",
                "300",
                "--host",
                "http://192.168.1.2:5055",
                "--allow-insecure-http",
                "--local-root",
                "/tmp/root",
            ]
        );

        let lan_https_no_flag = CliConnectionConfig {
            mode: "lan".into(),
            host: Some("http://192.168.1.2:5055".into()),
            allow_insecure_http: false,
            timeout_secs: 20,
        };
        assert_eq!(
            to_strings(build_global_cli_args(
                "p",
                &lan_https_no_flag,
                false,
                None,
                None
            )),
            vec![
                "--profile",
                "p",
                "--mode",
                "lan",
                "--timeout",
                "20",
                "--host",
                "http://192.168.1.2:5055",
            ]
        );

        // Switching back to cloud/auto with clear_host strips --host and passes --clear-host
        assert_eq!(
            to_strings(build_global_cli_args("p", &auto_cfg, true, None, None)),
            vec![
                "--profile",
                "p",
                "--mode",
                "auto",
                "--timeout",
                "30",
                "--clear-host"
            ]
        );
    }

    #[test]
    fn attachment_params_strictly_match_cli_whitelists_and_extract_fields() {
        let up = build_attachment_upload_params(42, "invoice.pdf");
        let keys: Vec<&str> = up.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["action", "id", "local_path", "location"]);
        assert_eq!(up["action"], "attachment_upload");
        assert_eq!(up["id"], 42);
        assert_eq!(up["location"], "2");
        assert_eq!(up["local_path"], "invoice.pdf");

        let parsed = extract_uploaded_attachment_fields(&json!({
            "file_id": 98765,
            "resource_path": "/notepad/res/98765.pdf"
        }))
        .unwrap();
        assert_eq!(parsed.0, "98765");
        assert_eq!(parsed.1.as_deref(), Some("/notepad/res/98765.pdf"));
        assert_eq!(parsed.2, None);

        let att = TaskAttachment {
            file_id: parsed.0,
            name: "invoice.pdf".into(),
            size: Some(1024),
            resource_path: parsed.1,
            safe_dir: Some("/pool/notepad".into()),
            uploaded_at: None,
        };
        let dl = build_attachment_download_params(&att, "invoice.pdf", true);
        let dl_keys: Vec<&str> = dl.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            dl_keys,
            vec![
                "action",
                "file_id",
                "local_path",
                "location",
                "overwrite",
                "safe_dir"
            ]
        );
        assert_eq!(dl["action"], "attachment_download");
        assert_eq!(dl["file_id"], "98765");
        assert_eq!(dl["safe_dir"], "/pool/notepad");
    }
}
