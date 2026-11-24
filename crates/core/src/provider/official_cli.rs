use crate::error::{AppError, AppResult};
use crate::provider::{AuthStatus, NoteCategory, NoteHistoryEntry, NoteSummary, NotebookProvider, RawNote};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

/// Active interactive OAuth2 login transaction (valid for 180s).
pub struct PendingOAuthLogin {
    pub url: String,
    pub expires_in: u64,
    stdin: ChildStdin,
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
}

impl OfficialCliNotebookProvider {
    pub fn new(cli_path: PathBuf, cli_home: PathBuf, profile: impl Into<String>) -> Self {
        Self {
            cli_path,
            cli_home,
            profile: profile.into(),
            pending_login: Mutex::new(None),
        }
    }

    fn base_command(&self) -> Command {
        let mut cmd = Command::new(&self.cli_path);
        cmd.env("ZSPACE_CLI_HOME", &self.cli_home)
            .arg("--profile")
            .arg(&self.profile);
        cmd
    }

    async fn run_json(&self, args: &[&str]) -> AppResult<Value> {
        let output = self
            .base_command()
            .args(args)
            .output()
            .await
            .map_err(|e| AppError::NasUnavailable(format!("无法启动 zspace-cli: {e}")))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if let Ok(val) = serde_json::from_str::<Value>(&stdout) {
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
    /// Keeps the CLI process alive waiting for the one-time auth code on stdin.
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
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("无法获取授权进程 stdout".into()))?;

        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
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

        let output = pending
            .child
            .wait_with_output()
            .await
            .map_err(|e| AppError::NasAuthFailed(format!("等待授权结果失败: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(AppError::NasAuthFailed(format!("授权失败: {stderr}")));
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
