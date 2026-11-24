mod scheduler;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use zspace_memo_core::models::{
    CreateTaskInput, OccurrenceActionStatus, OccurrenceView, RepeatRule, Task, TaskSort, TaskView,
    UpdateTaskInput,
};
use zspace_memo_core::provider::official_cli::{OAuthStartInfo, OfficialCliNotebookProvider};
use zspace_memo_core::provider::{AuthStatus, NotebookProvider};
use zspace_memo_core::recurrence::{
    build_occurrence_timeline, describe_rule_zh, generate_occurrences,
};
use zspace_memo_core::service::{SyncSummary, TaskService};
use zspace_memo_core::storage::{AppSettings, LocalStorage, NotificationRecord};

struct AppState {
    provider: Arc<OfficialCliNotebookProvider>,
    service: Arc<TaskService<OfficialCliNotebookProvider>>,
}

#[derive(Serialize)]
struct RepeatPreview {
    description: String,
    dates: Vec<String>,
}

fn map_err(e: zspace_memo_core::error::AppError) -> String {
    serde_json::to_string(&e.to_payload()).unwrap_or_else(|_| e.to_string())
}

#[tauri::command]
async fn auth_status(state: State<'_, AppState>) -> Result<AuthStatus, String> {
    state.provider.auth_status().await.map_err(map_err)
}

#[tauri::command]
async fn start_oauth_login(state: State<'_, AppState>) -> Result<OAuthStartInfo, String> {
    state.provider.start_oauth_login().await.map_err(map_err)
}

#[tauri::command]
async fn submit_oauth_code(
    state: State<'_, AppState>,
    code: String,
) -> Result<AuthStatus, String> {
    state.provider.submit_oauth_code(&code).await.map_err(map_err)
}

#[tauri::command]
async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    state.provider.logout().await.map_err(map_err)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.service.get_settings().map_err(map_err)
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
    state.service.save_settings(&settings).map_err(map_err)
}

#[tauri::command]
async fn initialize_category(
    state: State<'_, AppState>,
    create_if_missing: bool,
) -> Result<i64, String> {
    state
        .service
        .initialize_todo_category(create_if_missing)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn sync_tasks(state: State<'_, AppState>) -> Result<SyncSummary, String> {
    state.service.sync().await.map_err(map_err)
}

#[tauri::command]
fn list_tasks(
    state: State<'_, AppState>,
    view: TaskView,
    keyword: Option<String>,
    sort: TaskSort,
) -> Result<Vec<Task>, String> {
    state
        .service
        .list_tasks(view, keyword.as_deref(), sort)
        .map_err(map_err)
}

#[tauri::command]
async fn get_task(
    state: State<'_, AppState>,
    id: i64,
    refresh: bool,
) -> Result<Task, String> {
    state.service.get_task(id, refresh).await.map_err(map_err)
}

#[tauri::command]
async fn create_task(
    state: State<'_, AppState>,
    input: CreateTaskInput,
) -> Result<Task, String> {
    state.service.create_task(input).await.map_err(map_err)
}

#[tauri::command]
async fn update_task(
    state: State<'_, AppState>,
    id: i64,
    patch: UpdateTaskInput,
) -> Result<Task, String> {
    state.service.update_task(id, patch).await.map_err(map_err)
}

#[tauri::command]
async fn complete_task(
    state: State<'_, AppState>,
    id: i64,
    occurrence_key: Option<String>,
) -> Result<Task, String> {
    state
        .service
        .act_on_occurrence(id, occurrence_key.as_deref(), OccurrenceActionStatus::Completed)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn skip_occurrence(
    state: State<'_, AppState>,
    id: i64,
    occurrence_key: Option<String>,
) -> Result<Task, String> {
    state
        .service
        .act_on_occurrence(id, occurrence_key.as_deref(), OccurrenceActionStatus::Skipped)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn reopen_task(
    state: State<'_, AppState>,
    id: i64,
    occurrence_key: Option<String>,
) -> Result<Task, String> {
    state
        .service
        .reopen_task(id, occurrence_key.as_deref())
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn end_series(state: State<'_, AppState>, id: i64) -> Result<Task, String> {
    state.service.end_series(id).await.map_err(map_err)
}

#[tauri::command]
async fn delete_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.service.delete_task(id).await.map_err(map_err)
}

#[tauri::command]
async fn get_occurrence_timeline(
    state: State<'_, AppState>,
    id: i64,
    future_count: usize,
) -> Result<Vec<OccurrenceView>, String> {
    let task = state.service.get_task(id, false).await.map_err(map_err)?;
    let (Some(rule), Some(series)) = (&task.repeat, &task.series) else {
        return Ok(Vec::new());
    };
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    build_occurrence_timeline(rule, series, &task.schedule, &today, future_count).map_err(map_err)
}

#[tauri::command]
fn preview_repeat(rule: RepeatRule, count: usize) -> Result<RepeatPreview, String> {
    let dates = generate_occurrences(&rule, count.min(20), None).map_err(map_err)?;
    Ok(RepeatPreview {
        description: describe_rule_zh(&rule),
        dates,
    })
}

#[tauri::command]
fn list_notifications(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<NotificationRecord>, String> {
    state.service.list_notifications(limit).map_err(map_err)
}

#[tauri::command]
fn mark_notification_read(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.service.mark_notification_read(id).map_err(map_err)
}

#[tauri::command]
fn snooze_reminder(
    state: State<'_, AppState>,
    task_id: i64,
    occurrence_key: String,
    minutes: i64,
    title: String,
    body: String,
) -> Result<String, String> {
    state
        .service
        .snooze_reminder(task_id, &occurrence_key, minutes, &title, &body)
        .map_err(map_err)
}

#[tauri::command]
fn open_main_window(app: AppHandle, task_id: Option<i64>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        if let Some(id) = task_id {
            let _ = win.emit("task:select", id);
        }
    }
    Ok(())
}

#[tauri::command]
fn toggle_floating_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("floating") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.emit("floating:focus-input", ());
        }
    }
    Ok(())
}

fn resolve_cli_path(app: &AppHandle) -> PathBuf {
    if let Ok(env_path) = std::env::var("ZSPACE_CLI_BIN") {
        return PathBuf::from(env_path);
    }
    // Bundled sidecar next to executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) {
                "zspace-cli.exe"
            } else {
                "zspace-cli"
            };
            let candidate = dir.join(name);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    let _ = app;
    PathBuf::from("zspace-cli")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt::try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let db_path = data_dir.join("zspace_memo.db");
            let cli_home = data_dir.join("zspace-cli");
            let cli_path = resolve_cli_path(app.handle());

            let storage = Arc::new(LocalStorage::open(&db_path).expect("failed to open SQLite"));
            let provider = Arc::new(OfficialCliNotebookProvider::new(
                cli_path,
                cli_home,
                "zspace-memo",
            ));
            let service = Arc::new(TaskService::new(provider.clone(), storage));

            scheduler::spawn_background_scheduler(app.handle().clone(), service.clone());
            app.manage(AppState { provider, service });

            // System tray menu.
            let show_main = MenuItem::with_id(app, "show_main", "打开主界面", true, None::<&str>)?;
            let toggle_float =
                MenuItem::with_id(app, "toggle_float", "快捷悬浮窗", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 ZSpace Memo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_main, &toggle_float, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_main" => {
                        let _ = open_main_window(app.clone(), None);
                    }
                    "toggle_float" => {
                        let _ = toggle_floating_window(app.clone());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Global shortcut: Ctrl/Cmd + Shift + M toggles the floating quick window.
            let handle = app.handle().clone();
            let _ = app.global_shortcut().on_shortcut(
                "CommandOrControl+Shift+M",
                move |_app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = toggle_floating_window(handle.clone());
                    }
                },
            );

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let close_to_tray = state
                    .service
                    .get_settings()
                    .map(|s| s.close_to_tray)
                    .unwrap_or(true);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            start_oauth_login,
            submit_oauth_code,
            logout,
            get_settings,
            save_settings,
            initialize_category,
            sync_tasks,
            list_tasks,
            get_task,
            create_task,
            update_task,
            complete_task,
            skip_occurrence,
            reopen_task,
            end_series,
            delete_task,
            get_occurrence_timeline,
            preview_repeat,
            list_notifications,
            mark_notification_read,
            snooze_reminder,
            open_main_window,
            toggle_floating_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ZSpace Memo");
}
