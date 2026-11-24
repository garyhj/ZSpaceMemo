mod scheduler;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State,
    WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use zspace_memo_core::models::{
    CalendarTaskItem, CreateTaskInput, OccurrenceActionStatus, OccurrenceView, RepeatRule, Task,
    TaskSort, TaskView, UpdateTaskInput,
};
use zspace_memo_core::provider::official_cli::{OAuthStartInfo, OfficialCliNotebookProvider};
use zspace_memo_core::provider::{AuthStatus, NotebookProvider};
use zspace_memo_core::recurrence::{
    build_occurrence_timeline, describe_rule_zh, generate_occurrences,
};
use zspace_memo_core::service::{SyncSummary, TaskService};
use zspace_memo_core::storage::{AppSettings, LocalStorage, NotificationRecord};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DockEdge {
    Left,
    Right,
    Top,
}

#[derive(Default)]
struct FloatingDockState {
    docked: Option<DockEdge>,
    saved_pos: Option<PhysicalPosition<i32>>,
    saved_size: Option<PhysicalSize<u32>>,
    ignore_moves_until_ms: u64,
    move_seq: u64,
}

struct AppState {
    provider: Arc<OfficialCliNotebookProvider>,
    service: Arc<TaskService<OfficialCliNotebookProvider>>,
    dock: Mutex<FloatingDockState>,
}

#[derive(Serialize)]
struct RepeatPreview {
    description: String,
    dates: Vec<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn map_err(e: zspace_memo_core::error::AppError) -> String {
    serde_json::to_string(&e.to_payload()).unwrap_or_else(|_| e.to_string())
}

fn emit_changed(app: &AppHandle, source_window: &WebviewWindow) {
    let _ = app.emit("tasks:changed", source_window.label());
}

fn monitor_work_area(win: &WebviewWindow) -> Option<(i32, i32, i32, i32, f64)> {
    let m = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| win.available_monitors().ok().and_then(|v| v.into_iter().next()))?;
    let wa = m.work_area();
    let scale = m.scale_factor();
    Some((
        wa.position.x,
        wa.position.y,
        wa.position.x + wa.size.width as i32,
        wa.position.y + wa.size.height as i32,
        scale,
    ))
}

fn dock_floating(app: &AppHandle, edge_hint: Option<DockEdge>) {
    let Some(win) = app.get_webview_window("floating") else {
        return;
    };
    let Some((wa_left, wa_top, wa_right, wa_bottom, scale)) = monitor_work_area(&win) else {
        return;
    };
    let pos = win.outer_position().unwrap_or(PhysicalPosition::new(wa_right - 370, wa_top + 80));
    let size = win.outer_size().unwrap_or(PhysicalSize::new(350, 520));

    let edge = edge_hint.unwrap_or_else(|| {
        let center_x = pos.x + size.width as i32 / 2;
        if (center_x - wa_left) < (wa_right - center_x) {
            DockEdge::Left
        } else {
            DockEdge::Right
        }
    });

    {
        let state = app.state::<AppState>();
        let mut dock = state.dock.lock().unwrap();
        if dock.docked.is_none() {
            dock.saved_pos = Some(pos);
            dock.saved_size = Some(size);
        }
        dock.docked = Some(edge);
        dock.ignore_moves_until_ms = now_ms() + 800;
    }

    let (lw, lh) = match edge {
        DockEdge::Left | DockEdge::Right => (38_u32, 124_u32),
        DockEdge::Top => (144_u32, 34_u32),
    };
    let pw = (lw as f64 * scale).round() as i32;
    let ph = (lh as f64 * scale).round() as i32;

    let (nx, ny) = match edge {
        DockEdge::Left => (
            wa_left,
            pos.y.clamp(wa_top + 12, (wa_bottom - ph - 12).max(wa_top)),
        ),
        DockEdge::Right => (
            wa_right - pw,
            pos.y.clamp(wa_top + 12, (wa_bottom - ph - 12).max(wa_top)),
        ),
        DockEdge::Top => (
            pos.x.clamp(wa_left + 12, (wa_right - pw - 12).max(wa_left)),
            wa_top,
        ),
    };

    let _ = win.set_min_size(None::<LogicalSize<u32>>);
    let _ = win.set_resizable(false);
    let _ = win.set_size(LogicalSize::new(lw, lh));
    let _ = win.set_position(PhysicalPosition::new(nx, ny));
    let _ = win.emit("floating:dock-changed", Some(edge));
}

fn undock_floating(app: &AppHandle) {
    let Some(win) = app.get_webview_window("floating") else {
        return;
    };
    let (edge, saved_pos, saved_size) = {
        let state = app.state::<AppState>();
        let mut dock = state.dock.lock().unwrap();
        let edge = dock.docked.take();
        dock.ignore_moves_until_ms = now_ms() + 1000;
        (edge, dock.saved_pos, dock.saved_size)
    };

    let tab_pos = win.outer_position().ok();
    let (wa_left, wa_top, wa_right, wa_bottom, scale) =
        monitor_work_area(&win).unwrap_or((0, 0, 1440, 900, 1.0));

    let target_size = saved_size.unwrap_or_else(|| {
        PhysicalSize::new(
            (350.0 * scale).round() as u32,
            (520.0 * scale).round() as u32,
        )
    });
    let exp_w = target_size.width as i32;
    let exp_h = target_size.height as i32;
    let gap = (18.0 * scale).round() as i32;

    let base = tab_pos.or(saved_pos).unwrap_or(PhysicalPosition::new(wa_right - exp_w - gap, wa_top + 80));
    let (nx, ny) = match edge {
        Some(DockEdge::Left) => (
            wa_left + gap,
            base.y.clamp(wa_top + gap, (wa_bottom - exp_h - gap).max(wa_top)),
        ),
        Some(DockEdge::Right) => (
            wa_right - exp_w - gap,
            base.y.clamp(wa_top + gap, (wa_bottom - exp_h - gap).max(wa_top)),
        ),
        Some(DockEdge::Top) => (
            base.x.clamp(wa_left + gap, (wa_right - exp_w - gap).max(wa_left)),
            wa_top + gap,
        ),
        None => (
            base.x.clamp(wa_left + gap, (wa_right - exp_w - gap).max(wa_left)),
            base.y.clamp(wa_top + gap, (wa_bottom - exp_h - gap).max(wa_top)),
        ),
    };

    let _ = win.set_resizable(true);
    let _ = win.set_min_size(Some(LogicalSize::new(300_u32, 360_u32)));
    let _ = win.set_size(target_size);
    let _ = win.set_position(PhysicalPosition::new(nx, ny));
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit("floating:dock-changed", Option::<DockEdge>::None);
    let _ = win.emit("floating:focus-input", ());
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
async fn sync_tasks(app: AppHandle, state: State<'_, AppState>) -> Result<SyncSummary, String> {
    let summary = state.service.sync().await.map_err(map_err)?;
    let _ = app.emit("tasks:synced", &summary);
    Ok(summary)
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
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    refresh: bool,
) -> Result<Task, String> {
    let task = state.service.get_task(id, refresh).await.map_err(map_err)?;
    if refresh {
        emit_changed(&app, &window);
    }
    Ok(task)
}

#[tauri::command]
async fn create_task(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    input: CreateTaskInput,
) -> Result<Task, String> {
    let task = state.service.create_task(input).await.map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
}

#[tauri::command]
async fn update_task(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    patch: UpdateTaskInput,
) -> Result<Task, String> {
    let task = state.service.update_task(id, patch).await.map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
}

#[tauri::command]
async fn complete_task(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    occurrence_key: Option<String>,
) -> Result<Task, String> {
    let task = state
        .service
        .act_on_occurrence(id, occurrence_key.as_deref(), OccurrenceActionStatus::Completed)
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
}

#[tauri::command]
async fn skip_occurrence(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    occurrence_key: Option<String>,
) -> Result<Task, String> {
    let task = state
        .service
        .act_on_occurrence(id, occurrence_key.as_deref(), OccurrenceActionStatus::Skipped)
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
}

#[tauri::command]
async fn reopen_task(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    occurrence_key: Option<String>,
) -> Result<Task, String> {
    let task = state
        .service
        .reopen_task(id, occurrence_key.as_deref())
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
}

#[tauri::command]
async fn end_series(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
) -> Result<Task, String> {
    let task = state.service.end_series(id).await.map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
}

#[tauri::command]
async fn delete_task(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    state.service.delete_task(id).await.map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(())
}

#[tauri::command]
fn list_calendar_items(
    state: State<'_, AppState>,
    from: String,
    to: String,
    include_completed: bool,
) -> Result<Vec<CalendarTaskItem>, String> {
    state
        .service
        .list_calendar_items(&from, &to, include_completed)
        .map_err(map_err)
}

#[tauri::command]
async fn override_occurrence(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    occurrence_key: String,
    new_due_date: String,
    new_due_time: Option<String>,
) -> Result<Task, String> {
    let task = state
        .service
        .override_occurrence(id, &occurrence_key, &new_due_date, new_due_time.as_deref())
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
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
        let visible = win.is_visible().unwrap_or(false);
        let is_docked = app.state::<AppState>().dock.lock().unwrap().docked.is_some();
        if is_docked {
            undock_floating(&app);
        } else if visible {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.emit("floating:focus-input", ());
        }
    }
    Ok(())
}

#[tauri::command]
fn dock_floating_window(app: AppHandle, edge: Option<String>) -> Result<(), String> {
    let parsed = match edge.as_deref() {
        Some("left") => Some(DockEdge::Left),
        Some("right") => Some(DockEdge::Right),
        Some("top") => Some(DockEdge::Top),
        _ => None,
    };
    dock_floating(&app, parsed);
    Ok(())
}

#[tauri::command]
fn undock_floating_window(app: AppHandle) -> Result<(), String> {
    undock_floating(&app);
    Ok(())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

fn resolve_cli_path(app: &AppHandle) -> PathBuf {
    if let Ok(env_path) = std::env::var("ZSPACE_CLI_BIN") {
        return PathBuf::from(env_path);
    }
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
            app.manage(AppState {
                provider,
                service,
                dock: Mutex::new(FloatingDockState::default()),
            });

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
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "floating" {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
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
            WindowEvent::Moved(_) if window.label() == "floating" => {
                let app = window.app_handle().clone();
                let seq_opt = {
                    let state = app.state::<AppState>();
                    let mut dock = state.dock.lock().unwrap();
                    if dock.docked.is_some() || now_ms() < dock.ignore_moves_until_ms {
                        None
                    } else {
                        dock.move_seq += 1;
                        Some(dock.move_seq)
                    }
                };
                if let Some(seq) = seq_opt {
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(480)).await;
                        let should_check = {
                            let state = app.state::<AppState>();
                            let dock = state.dock.lock().unwrap();
                            dock.move_seq == seq
                                && dock.docked.is_none()
                                && now_ms() >= dock.ignore_moves_until_ms
                        };
                        if !should_check {
                            return;
                        }
                        let Some(win) = app.get_webview_window("floating") else {
                            return;
                        };
                        if !win.is_visible().unwrap_or(false) {
                            return;
                        }
                        let Some((wa_left, wa_top, wa_right, _wa_bottom, scale)) =
                            monitor_work_area(&win)
                        else {
                            return;
                        };
                        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
                            return;
                        };
                        let thresh = (20.0 * scale).round() as i32;
                        let edge = if pos.x <= wa_left + thresh {
                            Some(DockEdge::Left)
                        } else if pos.x + size.width as i32 >= wa_right - thresh {
                            Some(DockEdge::Right)
                        } else if pos.y <= wa_top + thresh {
                            Some(DockEdge::Top)
                        } else {
                            None
                        };
                        if let Some(e) = edge {
                            dock_floating(&app, Some(e));
                        }
                    });
                }
            }
            _ => {}
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
            list_calendar_items,
            override_occurrence,
            get_occurrence_timeline,
            preview_repeat,
            list_notifications,
            mark_notification_read,
            snooze_reminder,
            open_main_window,
            toggle_floating_window,
            dock_floating_window,
            undock_floating_window,
            set_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ZSpace Memo");
}
