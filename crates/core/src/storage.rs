use crate::error::AppResult;
use crate::models::Task;
use crate::reminder::ComputedReminderJob;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSettings {
    pub todo_category_name: String,
    pub todo_category_id: Option<i64>,
    pub timezone: String,
    pub default_all_day_reminder_time: String,
    pub upcoming_days: u32,
    pub sync_interval_secs: u64,
    pub show_overdue_in_today: bool,
    pub close_to_tray: bool,
    pub autostart: bool,
    #[serde(default = "default_true")]
    pub default_auto_remind: bool,
    #[serde(default = "default_true")]
    pub notification_sound: bool,
    #[serde(default = "default_sticky_cat")]
    pub sticky_category_name: String,
    #[serde(default)]
    pub sticky_category_id: Option<i64>,
    #[serde(default)]
    pub nas_drop_dir: Option<String>,
    #[serde(default = "default_true")]
    pub bridge_nas_events: bool,
    #[serde(default = "default_connection_mode")]
    pub connection_mode: String,
    #[serde(default)]
    pub lan_host: Option<String>,
    #[serde(default)]
    pub allow_insecure_http: bool,
    #[serde(default = "default_cli_timeout")]
    pub cli_timeout_secs: u64,
}

fn default_true() -> bool {
    true
}

fn default_sticky_cat() -> String {
    "ZSpace Sticky".into()
}

fn default_connection_mode() -> String {
    "auto".into()
}

fn default_cli_timeout() -> u64 {
    30
}

impl AppSettings {
    pub fn normalized_and_validated(&self) -> AppResult<Self> {
        let mut next = self.clone();
        let mode = next.connection_mode.trim().to_ascii_lowercase();
        if !matches!(mode.as_str(), "auto" | "cloud" | "lan") {
            return Err(crate::error::AppError::Validation(format!(
                "不支持的连接模式：{mode}（仅支持 auto / cloud / lan）"
            )));
        }
        next.connection_mode = mode;

        next.lan_host = next
            .lan_host
            .take()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());

        if let Some(host) = &next.lan_host {
            if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(crate::error::AppError::Validation(
                    "内网 NAS 地址不能包含空格或控制字符".into(),
                ));
            }
            let lower = host.to_ascii_lowercase();
            let rest = if let Some(r) = lower.strip_prefix("https://") {
                r
            } else if let Some(r) = lower.strip_prefix("http://") {
                r
            } else {
                return Err(crate::error::AppError::Validation(
                    "内网 NAS 地址必须以 https:// 或 http:// 开头（例如 https://192.168.1.2:5056）"
                        .into(),
                ));
            };
            if rest.is_empty() || rest.starts_with('/') {
                return Err(crate::error::AppError::Validation(
                    "内网 NAS 地址缺少主机名或 IP".into(),
                ));
            }
            if next.connection_mode == "lan"
                && lower.starts_with("http://")
                && !next.allow_insecure_http
            {
                return Err(crate::error::AppError::Validation(
                    "使用 http:// 内网直连地址需勾选「允许不安全 HTTP 内网直连」，建议优先使用 https://"
                        .into(),
                ));
            }
        } else if next.connection_mode == "lan" {
            return Err(crate::error::AppError::Validation(
                "选择 LAN 内网直连模式时请填写 NAS 内网地址（如 https://192.168.1.2:5056）".into(),
            ));
        }

        next.cli_timeout_secs = next.cli_timeout_secs.clamp(10, 600);
        Ok(next)
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            todo_category_name: "ZSpace Memo".into(),
            todo_category_id: None,
            timezone: "Asia/Shanghai".into(),
            default_all_day_reminder_time: "09:00".into(),
            upcoming_days: 7,
            sync_interval_secs: 300,
            show_overdue_in_today: true,
            close_to_tray: true,
            autostart: true,
            default_auto_remind: true,
            notification_sound: true,
            sticky_category_name: default_sticky_cat(),
            sticky_category_id: None,
            nas_drop_dir: None,
            bridge_nas_events: true,
            connection_mode: default_connection_mode(),
            lan_host: None,
            allow_insecure_http: false,
            cli_timeout_secs: default_cli_timeout(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CachedTaskRow {
    pub id: i64,
    pub updated_at_unix: i64,
    pub length: i64,
    pub task: Task,
    pub last_valid_task_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationRecord {
    pub id: i64,
    pub job_key: String,
    pub task_id: i64,
    pub occurrence_key: String,
    pub title: String,
    pub body: String,
    pub fired_at_utc: String,
    pub late: bool,
    pub read: bool,
}

#[derive(Debug, Clone)]
pub struct DueReminderJob {
    pub job_key: String,
    pub task_id: i64,
    pub occurrence_key: String,
    pub reminder_id: String,
    pub fire_at_unix: i64,
    pub title: String,
    pub body: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGeometryRecord {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dock_edge: Option<String>,
    #[serde(default)]
    pub visible: bool,
}

/// Local SQLite store (settings, rebuildable task index cache, reminder jobs, notifications).
pub struct LocalStorage {
    conn: Mutex<Connection>,
}

impl LocalStorage {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init_schema()?;
        Ok(store)
    }

    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_index (
                id INTEGER PRIMARY KEY,
                updated_at_unix INTEGER NOT NULL,
                length INTEGER NOT NULL,
                task_json TEXT NOT NULL,
                last_valid_task_json TEXT
            );
            CREATE TABLE IF NOT EXISTS reminder_jobs (
                job_key TEXT PRIMARY KEY,
                task_id INTEGER NOT NULL,
                occurrence_key TEXT NOT NULL,
                reminder_id TEXT NOT NULL,
                fire_at_unix INTEGER NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'rule',
                status TEXT NOT NULL DEFAULT 'pending',
                updated_at_unix INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_reminder_jobs_due
                ON reminder_jobs(status, fire_at_unix);
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_key TEXT NOT NULL,
                task_id INTEGER NOT NULL,
                occurrence_key TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                fired_at_utc TEXT NOT NULL,
                late INTEGER NOT NULL DEFAULT 0,
                read INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sticky_index (
                id INTEGER PRIMARY KEY,
                updated_at_unix INTEGER NOT NULL,
                length INTEGER NOT NULL,
                note_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS nas_seen_events (
                event_id TEXT PRIMARY KEY,
                seen_at_unix INTEGER NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    pub fn load_settings(&self) -> AppResult<AppSettings> {
        let conn = self.conn.lock().unwrap();
        let val: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'app_settings'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        match val {
            Some(s) => Ok(serde_json::from_str(&s)?),
            None => Ok(AppSettings::default()),
        }
    }

    pub fn save_settings(&self, settings: &AppSettings) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let json = serde_json::to_string(settings)?;
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('app_settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![json],
        )?;
        Ok(())
    }

    pub fn get_cached_task(&self, id: i64) -> AppResult<Option<CachedTaskRow>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT id, updated_at_unix, length, task_json, last_valid_task_json FROM task_index WHERE id = ?1",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?;
        match row {
            Some((id, updated_at_unix, length, task_json, last_valid_task_json)) => {
                let task: Task = serde_json::from_str(&task_json)?;
                Ok(Some(CachedTaskRow {
                    id,
                    updated_at_unix,
                    length,
                    task,
                    last_valid_task_json,
                }))
            }
            None => Ok(None),
        }
    }

    pub fn list_cached_tasks(&self) -> AppResult<Vec<Task>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT task_json FROM task_index")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(serde_json::from_str(&r?)?);
        }
        Ok(out)
    }

    pub fn upsert_cached_task(
        &self,
        task: &Task,
        updated_at_unix: i64,
        length: i64,
        update_last_valid: bool,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let task_json = serde_json::to_string(task)?;
        if update_last_valid {
            conn.execute(
                "INSERT INTO task_index(id, updated_at_unix, length, task_json, last_valid_task_json)
                 VALUES(?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   updated_at_unix = excluded.updated_at_unix,
                   length = excluded.length,
                   task_json = excluded.task_json,
                   last_valid_task_json = excluded.last_valid_task_json",
                params![task.id, updated_at_unix, length, task_json],
            )?;
        } else {
            conn.execute(
                "INSERT INTO task_index(id, updated_at_unix, length, task_json, last_valid_task_json)
                 VALUES(?1, ?2, ?3, ?4, NULL)
                 ON CONFLICT(id) DO UPDATE SET
                   updated_at_unix = excluded.updated_at_unix,
                   length = excluded.length,
                   task_json = excluded.task_json",
                params![task.id, updated_at_unix, length, task_json],
            )?;
        }
        Ok(())
    }

    pub fn remove_cached_tasks_except(&self, keep_ids: &[i64]) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        if keep_ids.is_empty() {
            conn.execute("DELETE FROM task_index", [])?;
            return Ok(());
        }
        let placeholders = keep_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM task_index WHERE id NOT IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        stmt.execute(rusqlite::params_from_iter(keep_ids.iter()))?;
        Ok(())
    }

    pub fn delete_cached_task(&self, id: i64) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM task_index WHERE id = ?1", params![id])?;
        conn.execute(
            "UPDATE reminder_jobs SET status = 'cancelled' WHERE task_id = ?1 AND status = 'pending'",
            params![id],
        )?;
        Ok(())
    }

    /// Reconcile rule-based reminder jobs for a task (preserves already-sent jobs and snoozes).
    pub fn reconcile_task_jobs(&self, task_id: i64, jobs: &[ComputedReminderJob]) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let now_unix = Utc::now().timestamp();
        let active_keys: Vec<&str> = jobs.iter().map(|j| j.job_key.as_str()).collect();

        if active_keys.is_empty() {
            conn.execute(
                "UPDATE reminder_jobs SET status = 'cancelled', updated_at_unix = ?1
                 WHERE task_id = ?2 AND kind = 'rule' AND status = 'pending'",
                params![now_unix, task_id],
            )?;
        } else {
            let placeholders = active_keys.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "UPDATE reminder_jobs SET status = 'cancelled', updated_at_unix = ?1
                 WHERE task_id = ?2 AND kind = 'rule' AND status = 'pending' AND job_key NOT IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut p: Vec<rusqlite::types::Value> = vec![now_unix.into(), task_id.into()];
            for k in &active_keys {
                p.push((*k).to_string().into());
            }
            stmt.execute(rusqlite::params_from_iter(p))?;
        }

        for j in jobs {
            conn.execute(
                "INSERT INTO reminder_jobs(job_key, task_id, occurrence_key, reminder_id, fire_at_unix, title, body, kind, status, updated_at_unix)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'rule', 'pending', ?8)
                 ON CONFLICT(job_key) DO UPDATE SET
                   title = excluded.title,
                   body = excluded.body,
                   updated_at_unix = excluded.updated_at_unix
                 WHERE reminder_jobs.status = 'pending'",
                params![
                    j.job_key,
                    j.task_id,
                    j.occurrence_key,
                    j.reminder_id,
                    j.fire_at_utc.timestamp(),
                    j.title,
                    j.body,
                    now_unix
                ],
            )?;
        }
        Ok(())
    }

    pub fn add_snooze_job(
        &self,
        task_id: i64,
        occurrence_key: &str,
        fire_at_utc: DateTime<Utc>,
        title: &str,
        body: &str,
    ) -> AppResult<String> {
        let conn = self.conn.lock().unwrap();
        let now_unix = Utc::now().timestamp();
        let job_key = format!("snooze-{task_id}-{occurrence_key}-{}", fire_at_utc.timestamp());
        conn.execute(
            "INSERT OR REPLACE INTO reminder_jobs(job_key, task_id, occurrence_key, reminder_id, fire_at_unix, title, body, kind, status, updated_at_unix)
             VALUES(?1, ?2, ?3, 'snooze', ?4, ?5, ?6, 'snooze', 'pending', ?7)",
            params![job_key, task_id, occurrence_key, fire_at_utc.timestamp(), title, body, now_unix],
        )?;
        Ok(job_key)
    }

    /// Atomically claim all pending jobs whose `fire_at_unix <= now_unix` (marks them `firing`).
    pub fn claim_due_jobs(&self, now_unix: i64) -> AppResult<Vec<DueReminderJob>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let jobs: Vec<DueReminderJob> = {
            let mut stmt = tx.prepare(
                "SELECT job_key, task_id, occurrence_key, reminder_id, fire_at_unix, title, body, kind
                 FROM reminder_jobs WHERE status = 'pending' AND fire_at_unix <= ?1
                 ORDER BY fire_at_unix ASC",
            )?;
            let rows = stmt.query_map(params![now_unix], |r| {
                Ok(DueReminderJob {
                    job_key: r.get(0)?,
                    task_id: r.get(1)?,
                    occurrence_key: r.get(2)?,
                    reminder_id: r.get(3)?,
                    fire_at_unix: r.get(4)?,
                    title: r.get(5)?,
                    body: r.get(6)?,
                    kind: r.get(7)?,
                })
            })?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row?);
            }
            v
        };
        for j in &jobs {
            tx.execute(
                "UPDATE reminder_jobs SET status = 'firing', updated_at_unix = ?1 WHERE job_key = ?2",
                params![now_unix, j.job_key],
            )?;
        }
        tx.commit()?;
        Ok(jobs)
    }

    pub fn mark_job_status(&self, job_key: &str, status: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE reminder_jobs SET status = ?1, updated_at_unix = ?2 WHERE job_key = ?3",
            params![status, Utc::now().timestamp(), job_key],
        )?;
        Ok(())
    }

    pub fn record_notification(
        &self,
        job_key: &str,
        task_id: i64,
        occurrence_key: &str,
        title: &str,
        body: &str,
        late: bool,
    ) -> AppResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO notifications(job_key, task_id, occurrence_key, title, body, fired_at_utc, late, read)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            params![
                job_key,
                task_id,
                occurrence_key,
                title,
                body,
                Utc::now().to_rfc3339(),
                if late { 1 } else { 0 }
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_notifications(&self, limit: u32) -> AppResult<Vec<NotificationRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, job_key, task_id, occurrence_key, title, body, fired_at_utc, late, read
             FROM notifications ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok(NotificationRecord {
                id: r.get(0)?,
                job_key: r.get(1)?,
                task_id: r.get(2)?,
                occurrence_key: r.get(3)?,
                title: r.get(4)?,
                body: r.get(5)?,
                fired_at_utc: r.get(6)?,
                late: r.get::<_, i64>(7)? != 0,
                read: r.get::<_, i64>(8)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn mark_notification_read(&self, id: i64) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE notifications SET read = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_sticky(&self, id: i64) -> AppResult<Option<(i64, i64, String)>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT updated_at_unix, length, note_json FROM sticky_index WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_stickies(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT note_json FROM sticky_index")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn upsert_sticky(&self, id: i64, updated_at_unix: i64, length: i64, note_json: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sticky_index(id, updated_at_unix, length, note_json)
             VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
               updated_at_unix = excluded.updated_at_unix,
               length = excluded.length,
               note_json = excluded.note_json",
            params![id, updated_at_unix, length, note_json],
        )?;
        Ok(())
    }

    pub fn delete_sticky(&self, id: i64) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sticky_index WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn has_any_seen_nas_events(&self) -> AppResult<bool> {
        let conn = self.conn.lock().unwrap();
        let cnt: i64 = conn.query_row("SELECT COUNT(*) FROM nas_seen_events", [], |r| r.get(0))?;
        Ok(cnt > 0)
    }

    pub fn is_nas_event_seen(&self, event_id: &str) -> AppResult<bool> {
        let conn = self.conn.lock().unwrap();
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM nas_seen_events WHERE event_id = ?1",
                params![event_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    pub fn mark_nas_event_seen(&self, event_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO nas_seen_events(event_id, seen_at_unix) VALUES(?1, ?2)",
            params![event_id, Utc::now().timestamp()],
        )?;
        Ok(())
    }

    pub fn get_kv(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(Into::into)
    }

    pub fn set_kv(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_kv(&self, key: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn load_window_geometry(&self, label: &str) -> AppResult<Option<WindowGeometryRecord>> {
        let Some(raw) = self.get_kv(&format!("win_geom:{label}"))? else {
            return Ok(None);
        };
        Ok(serde_json::from_str(&raw).ok())
    }

    pub fn save_window_geometry(&self, label: &str, geom: &WindowGeometryRecord) -> AppResult<()> {
        let json = serde_json::to_string(geom)?;
        self.set_kv(&format!("win_geom:{label}"), &json)
    }

    pub fn delete_window_geometry(&self, label: &str) -> AppResult<()> {
        self.delete_kv(&format!("win_geom:{label}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_geometry_persistence_round_trips_and_deletes() {
        let store = LocalStorage::open_in_memory().unwrap();
        assert_eq!(store.load_window_geometry("floating").unwrap(), None);

        let rec = WindowGeometryRecord {
            x: 1080,
            y: 120,
            width: 360,
            height: 540,
            dock_edge: Some("right".to_string()),
            visible: true,
        };
        store.save_window_geometry("floating", &rec).unwrap();
        assert_eq!(store.load_window_geometry("floating").unwrap(), Some(rec));

        store.delete_window_geometry("floating").unwrap();
        assert_eq!(store.load_window_geometry("floating").unwrap(), None);
    }

    #[test]
    fn legacy_settings_migrate_with_connection_defaults_and_validate_lan() {
        let legacy_json = r#"{
            "todo_category_name": "ZSpace Memo",
            "todo_category_id": 2,
            "timezone": "Asia/Shanghai",
            "default_all_day_reminder_time": "09:00",
            "upcoming_days": 7,
            "sync_interval_secs": 300,
            "show_overdue_in_today": true,
            "close_to_tray": true,
            "autostart": true
        }"#;
        let parsed: AppSettings = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(parsed.connection_mode, "auto");
        assert_eq!(parsed.lan_host, None);
        assert!(!parsed.allow_insecure_http);
        assert_eq!(parsed.cli_timeout_secs, 30);

        let mut bad_http = parsed.clone();
        bad_http.connection_mode = "LAN".into();
        bad_http.lan_host = Some("http://192.168.1.2:5055/".into());
        assert!(bad_http.normalized_and_validated().is_err());

        bad_http.allow_insecure_http = true;
        bad_http.cli_timeout_secs = 2;
        let ok = bad_http.normalized_and_validated().unwrap();
        assert_eq!(ok.connection_mode, "lan");
        assert_eq!(ok.lan_host.as_deref(), Some("http://192.168.1.2:5055"));
        assert_eq!(ok.cli_timeout_secs, 10);

        let mut missing_host = parsed.clone();
        missing_host.connection_mode = "lan".into();
        assert!(missing_host.normalized_and_validated().is_err());

        let mut bad_scheme = parsed;
        bad_scheme.connection_mode = "lan".into();
        bad_scheme.lan_host = Some("192.168.1.2:5055".into());
        assert!(bad_scheme.normalized_and_validated().is_err());
    }
}
