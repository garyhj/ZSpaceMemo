use crate::error::{AppError, AppResult};
use crate::provider::{AuthStatus, NoteCategory, NoteHistoryEntry, NoteSummary, NotebookProvider, RawNote};
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
    ) -> (Command, bool) {
        let mut cmd = Command::new(&self.cli_path);
        cmd.env("ZSPACE_CLI_HOME", &self.cli_home);
        let cfg = self.connection_config();
        let clear_host = if allow_clear_host {
            self.pending_clear_host.swap(false, Ordering::AcqRel)
        } else {
            false
        };
        let global_args =
            build_global_cli_args(&self.profile, &cfg, clear_host, timeout_override, local_root);
        cmd.args(global_args);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        (cmd, clear_host)
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
        let (mut cmd, cleared) = self.build_command(timeout_secs, local_root, true);
        let output = match cmd.args(args).output().await {
            Ok(out) => out,
            Err(e) => {
                if cleared {
                    self.pending_clear_host.store(true, Ordering::Release);
                }
                return Err(AppError::NasUnavailable(format!("无法启动 zspace-cli: {e}")));
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

        if !output.status.success() {
            return Err(AppError::NasUnavailable(format!(
                "zspace-cli 执行失败 (code {:?}): {}",
                output.status.code(),
                if !stderr.is_empty() { stderr } else { stdout }
            )));
        }

        Err(AppError::Internal(format!(
            "zspace-cli 返回非 JSON 输出: {}",
            &stdout[..stdout.len().min(200)]
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
            let _ = std::fs::set_permissions(&self.cli_home, std::fs::Permissions::from_mode(0o700));
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
        Err(AppError::NasAuthFailed("授权进程未返回 oauth_authorization 链接".into()))
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
        let output = wait_res
            .map_err(|e| AppError::NasAuthFailed(format!("等待授权结果失败: {e}")))?;

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
        id: v.get("id").and_then(|x| x.as_i64()).ok_or_else(|| {
            AppError::Internal("NAS 返回的笔记缺少 id 字段".into())
        })?,
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

    async fn list_notes(&self, classify_id: i64, start: u32, num: u32) -> AppResult<Vec<NoteSummary>> {
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
                    title: item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    classify_id: item.get("classify_id").and_then(|v| v.as_i64()).unwrap_or(classify_id),
                    in_brief: item.get("in_brief").and_then(|v| v.as_str()).unwrap_or("").to_string(),
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
        let val = self
            .run_file_notes(json!({"action": "info", "location": "2", "id": id}), false)
            .await?;
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
            to_strings(build_global_cli_args("zspace-memo", &auto_cfg, false, None, None)),
            vec!["--profile", "zspace-memo", "--mode", "auto", "--timeout", "30"]
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
            to_strings(build_global_cli_args("p", &lan_https_no_flag, false, None, None)),
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
            vec!["--profile", "p", "--mode", "auto", "--timeout", "30", "--clear-host"]
        );
    }
}
