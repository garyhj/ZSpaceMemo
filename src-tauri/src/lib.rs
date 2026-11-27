mod logging;
mod scheduler;
mod state;
mod updater;
mod window_dock;

use serde_json::Value;
use state::*;
pub use state::refresh_tray_tooltip;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State,
    WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use window_dock::*;
use zspace_memo_core::models::{
    CalendarTaskItem, CreateTaskInput, OccurrenceActionStatus, OccurrenceView, RepeatRule, Task,
    TaskSort, TaskView, UpdateTaskInput,
};
use zspace_memo_core::provider::official_cli::{
    CliConnectionConfig, NasDoctorReport, OAuthStartInfo, OfficialCliNotebookProvider,
};
use zspace_memo_core::provider::{AuthStatus, NotebookProvider};
use zspace_memo_core::recurrence::{describe_rule_zh, generate_occurrences};
use zspace_memo_core::service::{SyncSummary, TaskService};
use zspace_memo_core::sticky::{CreateStickyInput, StickyNote, StickyService, UpdateStickyInput};
use zspace_memo_core::storage::{AppSettings, LocalStorage, NotificationRecord};
use zspace_memo_core::toolbox::{SystemOverview, ToolboxService, UploadBatchSummary};

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

fn sync_os_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if mgr.is_enabled().ok() == Some(enabled) {
        return Ok(());
    }
    if enabled {
        mgr.enable().map_err(|e| format!("启用开机自启失败：{e}"))
    } else {
        mgr.disable().map_err(|e| format!("关闭开机自启失败：{e}"))
    }
}

fn apply_global_shortcut(app: &AppHandle, prev: Option<&str>, next: &str) -> Result<(), String> {
    let _ = app.global_shortcut().unregister_all();
    let handle = app.clone();
    match app.global_shortcut().on_shortcut(next, move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = toggle_floating_window(handle.clone());
        }
    }) {
        Ok(()) => Ok(()),
        Err(e) => {
            if let Some(old) = prev.filter(|s| !s.trim().is_empty()) {
                let restore_handle = app.clone();
                let _ = app.global_shortcut().on_shortcut(old, move |_app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = toggle_floating_window(restore_handle.clone());
                    }
                });
            }
            Err(format!("注册全局快捷键「{next}」失败：{e}"))
        }
    }
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), String> {
    let prev = state.storage.load_settings().ok();
    let normalized = settings.normalized_and_validated().map_err(map_err)?;
    if prev.as_ref().is_some_and(|p| p.autostart != normalized.autostart) {
        sync_os_autostart(&app, normalized.autostart)?;
    }
    if prev.as_ref().is_some_and(|p| p.global_shortcut != normalized.global_shortcut) {
        let prev_sc = prev.as_ref().map(|p| p.global_shortcut.as_str());
        apply_global_shortcut(&app, prev_sc, &normalized.global_shortcut)?;
    }
    state.service.save_settings(&normalized).map_err(map_err)?;

    let should_clear_host = prev.as_ref().is_some_and(|p| {
        (p.connection_mode == "lan" || p.lan_host.is_some())
            && (normalized.connection_mode != "lan" || normalized.lan_host.is_none())
    });
    state
        .provider
        .set_connection_config(CliConnectionConfig::from(&normalized), should_clear_host);
    if should_clear_host {
        state.provider.flush_clear_host().await;
    }
    Ok(())
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
    refresh_tray_tooltip(&app);
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
async fn rename_label(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    old_label: String,
    new_label: String,
) -> Result<usize, String> {
    let count = state
        .service
        .rename_label(&old_label, &new_label)
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(count)
}

#[tauri::command]
async fn remove_label(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    label: String,
) -> Result<usize, String> {
    let count = state.service.remove_label(&label).await.map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(count)
}

#[tauri::command]
async fn batch_move_list(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    list: Option<String>,
) -> Result<usize, String> {
    let count = state
        .service
        .batch_move_list(&ids, list)
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(count)
}

#[tauri::command]
async fn batch_add_label(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    label: String,
) -> Result<usize, String> {
    let count = state
        .service
        .batch_add_label(&ids, &label)
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(count)
}

#[tauri::command]
async fn batch_complete_tasks(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    let count = state
        .service
        .batch_complete_tasks(&ids)
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(count)
}

#[tauri::command]
async fn upload_task_attachment(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    local_path: String,
) -> Result<Task, String> {
    let task = state
        .service
        .upload_task_attachment(id, &local_path)
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
}

#[tauri::command]
async fn download_task_attachment(
    state: State<'_, AppState>,
    id: i64,
    file_id: String,
    local_dest: String,
) -> Result<(), String> {
    state
        .service
        .download_task_attachment(id, &file_id, &local_dest)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn remove_task_attachment(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    file_id: String,
) -> Result<Task, String> {
    let task = state
        .service
        .remove_task_attachment(id, &file_id)
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
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
    new_all_day: Option<bool>,
    new_title: Option<String>,
) -> Result<Task, String> {
    let task = state
        .service
        .override_occurrence_detail(
            id,
            &occurrence_key,
            &new_due_date,
            new_due_time.as_deref(),
            new_all_day,
            new_title.as_deref(),
        )
        .await
        .map_err(map_err)?;
    emit_changed(&app, &window);
    Ok(task)
}

#[tauri::command]
async fn clear_occurrence_override(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    occurrence_key: String,
) -> Result<Task, String> {
    let task = state
        .service
        .clear_occurrence_override(id, &occurrence_key)
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
    state
        .service
        .get_occurrence_timeline(id, future_count)
        .await
        .map_err(map_err)
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

// --- OS Native Notification Commands ---

#[tauri::command]
fn notification_permission_state(app: AppHandle) -> Result<String, String> {
    app.notification()
        .permission_state()
        .map(|s| permission_label(s).to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn request_notification_permission(app: AppHandle) -> Result<String, String> {
    app.notification()
        .request_permission()
        .map(|s| permission_label(s).to_string())
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
const WINDOWS_AUMID: &str = "com.garyhj.zspacememo";

#[cfg(windows)]
static WINDOWS_AUMID_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
fn ensure_windows_aumid(app: Option<&AppHandle>) {
    if app.is_some() && WINDOWS_AUMID_DONE.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
            windows::core::h!("com.garyhj.zspacememo"),
        );
    }
    if let Ok(key) =
        windows_registry::CURRENT_USER.create(format!(r"SOFTWARE\Classes\AppUserModelId\{WINDOWS_AUMID}"))
    {
        let _ = key.set_string("DisplayName", "ZSpace Kit");
        let _ = key.set_string("IconBackgroundColor", "0");
        if let Some(handle) = app {
            if let Ok(data_dir) = handle.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir);
                let icon_path = data_dir.join("toast-icon.png");
                if !icon_path.exists() {
                    let _ = std::fs::write(&icon_path, include_bytes!("../icons/128x128.png"));
                }
                if let Some(s) = icon_path.to_str() {
                    let _ = key.set_string("IconUri", s);
                }
            }
            WINDOWS_AUMID_DONE.store(true, std::sync::atomic::Ordering::Release);
        }
    }
}

#[cfg(not(windows))]
fn ensure_windows_aumid(_app: Option<&AppHandle>) {}

pub(crate) fn send_native_notification(
    app: &AppHandle,
    title: &str,
    body: &str,
    sound: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Sound, Toast};
        ensure_windows_aumid(Some(app));
        let snd = if sound { Some(Sound::Default) } else { None };
        match Toast::new(WINDOWS_AUMID)
            .title(title)
            .text1(body)
            .sound(snd)
            .show()
        {
            Ok(()) => Ok(()),
            Err(e1) => {
                tracing::warn!(error = %e1, "WinRT toast via custom AUMID failed, retrying fallback");
                Toast::new(Toast::POWERSHELL_APP_ID)
                    .title(title)
                    .text1(body)
                    .sound(snd)
                    .show()
                    .map_err(|e2| format!("Windows 通知调用失败：{e1} / {e2}"))
            }
        }
    }
    #[cfg(not(windows))]
    {
        let mut b = app.notification().builder().title(title).body(body);
        if sound {
            b = b.sound("Default");
        }
        b.show().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn send_test_notification(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let sound = state
        .service
        .get_settings()
        .map(|s| s.notification_sound)
        .unwrap_or(true);
    send_native_notification(
        &app,
        "ZSpace Kit 系统提醒测试",
        "收到这条系统通知，说明你的 Windows / macOS 任务提醒已正常打通！",
        sound,
    )
}

// --- Sticky Notes Commands ---

#[tauri::command]
async fn init_sticky_category(
    state: State<'_, AppState>,
    create_if_missing: bool,
) -> Result<i64, String> {
    state
        .sticky
        .initialize_category(create_if_missing)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn sync_sticky_notes(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let fetched = state.sticky.sync().await.map_err(map_err)?;
    let _ = app.emit("sticky:synced", fetched);
    Ok(fetched)
}

#[tauri::command]
fn list_sticky_notes(
    state: State<'_, AppState>,
    keyword: Option<String>,
) -> Result<Vec<StickyNote>, String> {
    state
        .sticky
        .list_notes(keyword.as_deref())
        .map_err(map_err)
}

#[tauri::command]
fn get_sticky_note(state: State<'_, AppState>, id: i64) -> Result<Option<StickyNote>, String> {
    state.sticky.get_note(id).map_err(map_err)
}

#[tauri::command]
async fn create_sticky_note(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    input: CreateStickyInput,
) -> Result<StickyNote, String> {
    let note = state.sticky.create_note(input).await.map_err(map_err)?;
    emit_sticky_changed(&app, &window);
    if note.floating {
        let _ = ensure_sticky_window(&app, note.id).await;
    }
    Ok(note)
}

#[tauri::command]
async fn update_sticky_note(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
    patch: UpdateStickyInput,
) -> Result<StickyNote, String> {
    let note = state.sticky.update_note(id, patch).await.map_err(map_err)?;
    emit_sticky_changed(&app, &window);
    Ok(note)
}

#[tauri::command]
async fn delete_sticky_note(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    state.sticky.delete_note(id).await.map_err(map_err)?;
    let _ = state.storage.delete_window_geometry(&format!("sticky-{id}"));
    if let Some(win) = app.get_webview_window(&format!("sticky-{id}")) {
        let _ = win.close();
    }
    emit_sticky_changed(&app, &window);
    Ok(())
}

#[tauri::command]
async fn open_sticky_window(app: AppHandle, id: i64) -> Result<(), String> {
    ensure_sticky_window(&app, id).await
}

#[tauri::command]
async fn close_sticky_window(app: AppHandle, id: i64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&format!("sticky-{id}")) {
        let _ = win.close();
    }
    Ok(())
}

// --- ZSpace NAS Toolbox Commands (Files, System + Events, Docker) ---

#[tauri::command]
async fn nas_file_space(state: State<'_, AppState>) -> Result<Value, String> {
    state.toolbox.file_space().await.map_err(map_err)
}

#[tauri::command]
async fn nas_file_list(
    state: State<'_, AppState>,
    path: String,
    start: Option<u32>,
    num: Option<u32>,
) -> Result<Value, String> {
    state
        .toolbox
        .file_list(&path, start.unwrap_or(0), num.unwrap_or(100))
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_search_files(
    state: State<'_, AppState>,
    name: String,
    file_path: Option<String>,
) -> Result<Value, String> {
    state
        .toolbox
        .search_files(&name, file_path.as_deref())
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_mkdir(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> Result<Value, String> {
    state.toolbox.mkdir(&parent, &name).await.map_err(map_err)
}

#[tauri::command]
async fn nas_upload_file(
    state: State<'_, AppState>,
    local_path: String,
    dest_dir: String,
    rename_on_conflict: Option<bool>,
) -> Result<Value, String> {
    state
        .toolbox
        .upload_file(&local_path, &dest_dir, rename_on_conflict.unwrap_or(true))
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_upload_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    local_paths: Vec<String>,
    dest_dir: String,
    rename_on_conflict: Option<bool>,
    batch_id: Option<String>,
) -> Result<UploadBatchSummary, String> {
    let bid = batch_id.unwrap_or_else(|| format!("up_{}", now_ms()));
    state
        .toolbox
        .upload_paths(
            &local_paths,
            &dest_dir,
            rename_on_conflict.unwrap_or(true),
            &bid,
            |ev| {
                let _ = app.emit("files:transfer-progress", &ev);
            },
        )
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_download_file(
    state: State<'_, AppState>,
    nas_path: String,
    local_dest: String,
) -> Result<Value, String> {
    state
        .toolbox
        .download_file(&nas_path, &local_dest)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_doctor(state: State<'_, AppState>) -> Result<NasDoctorReport, String> {
    Ok(state.provider.doctor().await)
}

#[tauri::command]
async fn nas_system_overview(state: State<'_, AppState>) -> Result<SystemOverview, String> {
    state.toolbox.system_overview().await.map_err(map_err)
}

#[tauri::command]
async fn nas_list_events(
    state: State<'_, AppState>,
    event_type: Option<String>,
    num: Option<u32>,
) -> Result<Value, String> {
    state
        .toolbox
        .list_events(event_type.as_deref().unwrap_or(""), num.unwrap_or(30))
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_mark_events_read(state: State<'_, AppState>, ids: String) -> Result<Value, String> {
    state.toolbox.mark_events_read(&ids).await.map_err(map_err)
}

#[tauri::command]
async fn nas_mark_all_events_read(state: State<'_, AppState>) -> Result<Value, String> {
    state.toolbox.mark_all_events_read().await.map_err(map_err)
}

#[tauri::command]
async fn nas_docker_list(state: State<'_, AppState>) -> Result<Value, String> {
    state.toolbox.docker_list().await.map_err(map_err)
}

#[tauri::command]
async fn nas_docker_stats(state: State<'_, AppState>) -> Result<Value, String> {
    state.toolbox.docker_stats().await.map_err(map_err)
}

#[tauri::command]
async fn nas_docker_action(
    state: State<'_, AppState>,
    action: String,
    container_id: String,
) -> Result<Value, String> {
    state
        .toolbox
        .docker_action(&action, &container_id)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_docker_logs(
    state: State<'_, AppState>,
    container_id: String,
) -> Result<Value, String> {
    state
        .toolbox
        .docker_logs(&container_id)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_docker_images_list(state: State<'_, AppState>) -> Result<Value, String> {
    state.toolbox.docker_images_list().await.map_err(map_err)
}

#[tauri::command]
async fn nas_docker_compose_list(state: State<'_, AppState>) -> Result<Value, String> {
    state.toolbox.docker_compose_list().await.map_err(map_err)
}

#[tauri::command]
async fn nas_download_tasks(
    state: State<'_, AppState>,
    task_type: Option<String>,
    start: Option<u32>,
    size: Option<u32>,
) -> Result<Value, String> {
    state
        .toolbox
        .download_tasks(
            task_type.as_deref().unwrap_or("all"),
            start.unwrap_or(0),
            size.unwrap_or(100),
        )
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_download_dirs(state: State<'_, AppState>) -> Result<Value, String> {
    state.toolbox.download_dirs().await.map_err(map_err)
}

#[tauri::command]
async fn nas_download_add(
    state: State<'_, AppState>,
    uri: String,
    dir: Option<String>,
) -> Result<Value, String> {
    state
        .toolbox
        .download_add(&uri, dir.as_deref())
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn nas_download_action(
    state: State<'_, AppState>,
    action: String,
    ids: Vec<Value>,
) -> Result<Value, String> {
    state
        .toolbox
        .download_manage_action(&action, ids)
        .await
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
            persist_floating_state(&app, Some(false));
        } else {
            let saved = {
                let state = app.state::<AppState>();
                let dock = state.dock.lock().unwrap();
                match (dock.saved_pos, dock.saved_size) {
                    (Some(p), Some(s)) => Some((p.x, p.y, s.width, s.height)),
                    _ => state
                        .storage
                        .load_window_geometry("floating")
                        .ok()
                        .flatten()
                        .map(|r| (r.x, r.y, r.width, r.height)),
                }
            };
            if let Some((rx, ry, rw, rh)) = saved {
                if let Some((nx, ny, w, h)) =
                    clamp_physical_rect_to_monitors(&win, rx, ry, rw, rh, 300, 360)
                {
                    let state = app.state::<AppState>();
                    state.dock.lock().unwrap().ignore_moves_until_ms = now_ms() + 600;
                    let _ = win.set_size(PhysicalSize::new(w, h));
                    let _ = win.set_position(PhysicalPosition::new(nx, ny));
                }
            }
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.emit("floating:focus-input", ());
            persist_floating_state(&app, Some(true));
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
fn peek_floating_window(app: AppHandle) -> Result<(), String> {
    peek_floating(&app);
    Ok(())
}

#[tauri::command]
fn collapse_peek_floating_window(app: AppHandle) -> Result<(), String> {
    collapse_peek_floating(&app);
    Ok(())
}

#[tauri::command]
fn set_floating_peek_hold(app: AppHandle, hold: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut dock = state.dock.lock().unwrap();
    dock.peek_hold = hold;
    Ok(())
}

#[tauri::command]
fn undock_floating_window(app: AppHandle) -> Result<(), String> {
    undock_floating(&app);
    Ok(())
}

#[tauri::command]
fn set_autostart(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    sync_os_autostart(&app, enabled)?;
    if let Ok(mut cfg) = state.storage.load_settings() {
        if cfg.autostart != enabled {
            cfg.autostart = enabled;
            state.service.save_settings(&cfg).map_err(map_err)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn get_logs_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn open_logs_dir(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path_str = dir.to_string_lossy().to_string();
    app.opener()
        .open_path(path_str.clone(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(path_str)
}

#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<updater::UpdateCheckResult, String> {
    updater::check_app_update(&app).await
}

#[tauri::command]
async fn install_app_update(
    app: AppHandle,
    download_url: String,
    asset_name: String,
    expected_sha256: Option<String>,
) -> Result<(), String> {
    updater::install_app_update(app, download_url, asset_name, expected_sha256).await
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
    logging::init_subscriber();
    ensure_windows_aumid(None);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = open_main_window(app.clone(), None);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            ensure_windows_aumid(Some(app.handle()));
            updater::cleanup_stale_updates(app.handle());
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            logging::attach_log_dir(data_dir.join("logs"));
            let db_path = data_dir.join("zspace_memo.db");
            let cli_home = data_dir.join("zspace-cli");
            let cli_path = resolve_cli_path(app.handle());

            let storage = Arc::new(LocalStorage::open(&db_path).expect("failed to open SQLite"));
            let provider = Arc::new(OfficialCliNotebookProvider::new(
                cli_path,
                cli_home,
                "zspace-memo",
            ));
            if let Ok(saved_cfg) = storage.load_settings() {
                provider.set_connection_config(CliConnectionConfig::from(&saved_cfg), false);
                if let Err(e) = sync_os_autostart(app.handle(), saved_cfg.autostart) {
                    tracing::warn!(error = %e, "failed reconciling autostart on startup");
                }
            }
            let service = Arc::new(TaskService::new(provider.clone(), storage.clone()));
            let sticky = Arc::new(StickyService::new(provider.clone(), storage.clone()));
            let toolbox = Arc::new(ToolboxService::new(provider.clone(), storage.clone()));

            scheduler::spawn_background_scheduler(
                app.handle().clone(),
                service.clone(),
                sticky.clone(),
                toolbox.clone(),
            );
            app.manage(AppState {
                provider,
                service: service.clone(),
                sticky: sticky.clone(),
                toolbox,
                storage: storage.clone(),
                dock: Mutex::new(FloatingDockState::default()),
                tray: Mutex::new(None),
                geom_seqs: Mutex::new(HashMap::new()),
                geom_ignore_until_ms: Mutex::new(HashMap::new()),
            });

            if let Some(icon) = app.default_window_icon().cloned() {
                for label in ["main", "floating"] {
                    if let Some(win) = app.get_webview_window(label) {
                        let _ = win.set_icon(icon.clone());
                    }
                }
            }

            // Restore main window size & position safely inside active monitors.
            if let Ok(Some(rec)) = storage.load_window_geometry("main") {
                if let Some(win) = app.get_webview_window("main") {
                    if let Some((nx, ny, w, h)) =
                        clamp_physical_rect_to_monitors(&win, rec.x, rec.y, rec.width, rec.height, 820, 560)
                    {
                        mark_geom_ignore(app.handle(), "main", 800);
                        let _ = win.set_size(PhysicalSize::new(w, h));
                        let _ = win.set_position(PhysicalPosition::new(nx, ny));
                    }
                }
            }

            // Restore floating window saved geometry and dock state if previously open.
            if let Ok(Some(rec)) = storage.load_window_geometry("floating") {
                let state = app.state::<AppState>();
                {
                    let mut dock = state.dock.lock().unwrap();
                    dock.saved_pos = Some(PhysicalPosition::new(rec.x, rec.y));
                    dock.saved_size = Some(PhysicalSize::new(rec.width.max(300), rec.height.max(360)));
                }
                if rec.visible {
                    let app_float = app.handle().clone();
                    let dock_edge = rec.dock_edge.as_deref().and_then(DockEdge::parse);
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(350)).await;
                        if let Some(win) = app_float.get_webview_window("floating") {
                            if let Some((nx, ny, w, h)) = clamp_physical_rect_to_monitors(
                                &win, rec.x, rec.y, rec.width, rec.height, 300, 360,
                            ) {
                                {
                                    let state = app_float.state::<AppState>();
                                    let mut dock = state.dock.lock().unwrap();
                                    dock.saved_pos = Some(PhysicalPosition::new(nx, ny));
                                    dock.saved_size = Some(PhysicalSize::new(w, h));
                                    dock.ignore_moves_until_ms = now_ms() + 800;
                                }
                                let _ = win.set_size(PhysicalSize::new(w, h));
                                let _ = win.set_position(PhysicalPosition::new(nx, ny));
                            }
                            if let Some(edge) = dock_edge {
                                dock_floating(&app_float, Some(edge));
                                let _ = win.show();
                            } else {
                                let _ = win.show();
                            }
                        }
                    });
                }
            }

            // Ask OS notification permission if still in prompt state (macOS).
            if let Ok(PermissionState::Prompt | PermissionState::PromptWithRationale) =
                app.notification().permission_state()
            {
                let _ = app.notification().request_permission();
            }

            // Reopen desktop-pinned sticky notes after startup.
            let app_for_sticky = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(800)).await;
                if let Ok(notes) = sticky.list_notes(None) {
                    for n in notes.into_iter().filter(|n| n.floating).take(8) {
                        let _ = ensure_sticky_window(&app_for_sticky, n.id).await;
                    }
                }
            });

            // System tray menu & icon with direct actions and workspace switches.
            let show_main = MenuItem::with_id(app, "show_main", "打开 ZSpace Kit", true, None::<&str>)?;
            let toggle_float =
                MenuItem::with_id(app, "toggle_float", "悬浮待办窗", true, None::<&str>)?;
            let sync_now = MenuItem::with_id(app, "sync_now", "立即同步", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let nav_tasks = MenuItem::with_id(app, "nav:tasks", "待办清单", true, None::<&str>)?;
            let nav_cal = MenuItem::with_id(app, "nav:calendar", "月视图与农历", true, None::<&str>)?;
            let nav_sticky = MenuItem::with_id(app, "nav:sticky", "便签墙", true, None::<&str>)?;
            let nav_files = MenuItem::with_id(app, "nav:files", "快传箱", true, None::<&str>)?;
            let nav_nas = MenuItem::with_id(app, "nav:nas", "NAS 状态", true, None::<&str>)?;
            let nav_docker = MenuItem::with_id(app, "nav:docker", "Docker 管理", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出 ZSpace Kit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_main,
                    &toggle_float,
                    &sync_now,
                    &sep1,
                    &nav_tasks,
                    &nav_cal,
                    &nav_sticky,
                    &nav_files,
                    &nav_nas,
                    &nav_docker,
                    &sep2,
                    &quit,
                ],
            )?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("ZSpace Kit · 极空工具箱")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    if id == "show_main" {
                        let _ = open_main_window(app.clone(), None);
                    } else if id == "toggle_float" {
                        let _ = toggle_floating_window(app.clone());
                    } else if id == "sync_now" {
                        let app_sync = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app_sync.state::<AppState>();
                            if let Ok(summary) = state.service.sync().await {
                                let _ = app_sync.emit("tasks:synced", &summary);
                                refresh_tray_tooltip(&app_sync);
                            }
                            if let Ok(fetched) = state.sticky.sync().await {
                                let _ = app_sync.emit("sticky:synced", fetched);
                            }
                        });
                    } else if let Some(ws) = id.strip_prefix("nav:") {
                        let _ = open_main_window(app.clone(), None);
                        let _ = app.emit("workspace:navigate", ws.to_string());
                    } else if id == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let _ = open_main_window(tray.app_handle().clone(), None);
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            let tray = tray_builder.build(app)?;
            *app.state::<AppState>().tray.lock().unwrap() = Some(tray);
            refresh_tray_tooltip(app.handle());

            // Global shortcut: user-configured or default Ctrl/Cmd + Shift + M toggles the floating window.
            let configured_sc = storage
                .load_settings()
                .map(|s| s.global_shortcut)
                .unwrap_or_else(|_| "CommandOrControl+Shift+M".into());
            if let Err(e) = apply_global_shortcut(app.handle(), None, &configured_sc) {
                tracing::warn!(error = %e, shortcut = %configured_sc, "failed to register configured global shortcut, falling back");
                let _ = apply_global_shortcut(app.handle(), None, "CommandOrControl+Shift+M");
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "floating" {
                    api.prevent_close();
                    let _ = window.hide();
                    persist_floating_state(window.app_handle(), Some(false));
                    return;
                }
                if window.label().starts_with("sticky-") {
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
                } else {
                    window.app_handle().exit(0);
                }
            }
            WindowEvent::Moved(new_pos) if window.label() == "floating" => {
                let app = window.app_handle().clone();
                let (seq_opt, broke_peek) = {
                    let state = app.state::<AppState>();
                    let mut dock = state.dock.lock().unwrap();
                    if now_ms() < dock.ignore_moves_until_ms {
                        (None, false)
                    } else if dock.docked.is_some() && !dock.peeked {
                        (None, false)
                    } else if dock.docked.is_some() && dock.peeked {
                        // Ignore stray OS/DPI resize WM_MOVE events near the expected peek position.
                        let dragged_away = dock
                            .peek_pos
                            .map(|p| (new_pos.x - p.x).abs() > 24 || (new_pos.y - p.y).abs() > 24)
                            .unwrap_or(true);
                        if !dragged_away {
                            (None, false)
                        } else {
                            dock.docked = None;
                            dock.peeked = false;
                            dock.peek_hold = false;
                            dock.peek_seq += 1;
                            dock.peek_pos = None;
                            dock.tab_pos = None;
                            dock.move_seq += 1;
                            (Some(dock.move_seq), true)
                        }
                    } else {
                        dock.move_seq += 1;
                        (Some(dock.move_seq), false)
                    }
                };
                if broke_peek {
                    if let Some(win) = app.get_webview_window("floating") {
                        let _ = win.emit(
                            "floating:dock-changed",
                            FloatingDockPayload {
                                edge: None,
                                peeked: false,
                            },
                        );
                    }
                    persist_floating_state(&app, Some(true));
                }
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
                            persist_floating_state(&app, None);
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
                        } else {
                            persist_floating_state(&app, None);
                        }
                    });
                }
            }
            WindowEvent::Moved(_)
                if window.label() == "main" || window.label().starts_with("sticky-") =>
            {
                schedule_persist_window_geometry(
                    window.app_handle().clone(),
                    window.label().to_string(),
                );
            }
            WindowEvent::Resized(_) => {
                if window.label() == "floating" {
                    let app = window.app_handle().clone();
                    let seq_opt = {
                        let state = app.state::<AppState>();
                        let mut dock = state.dock.lock().unwrap();
                        if dock.docked.is_none()
                            && !dock.peeked
                            && now_ms() >= dock.ignore_moves_until_ms
                        {
                            dock.move_seq += 1;
                            Some(dock.move_seq)
                        } else {
                            None
                        }
                    };
                    if let Some(seq) = seq_opt {
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(450)).await;
                            let still = {
                                let state = app.state::<AppState>();
                                let dock = state.dock.lock().unwrap();
                                dock.move_seq == seq && dock.docked.is_none() && !dock.peeked
                            };
                            if still {
                                persist_floating_state(&app, None);
                            }
                        });
                    }
                } else if window.label() == "main" || window.label().starts_with("sticky-") {
                    schedule_persist_window_geometry(
                        window.app_handle().clone(),
                        window.label().to_string(),
                    );
                }
            }
            WindowEvent::Focused(false) if window.label() == "floating" => {
                let app = window.app_handle().clone();
                let should_check = {
                    let state = app.state::<AppState>();
                    let mut dock = state.dock.lock().unwrap();
                    dock.peek_hold = false;
                    dock.docked.is_some() && dock.peeked
                };
                if should_check {
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        if let Some(win) = app.get_webview_window("floating") {
                            let focused = win.is_focused().unwrap_or(false);
                            let inside = is_cursor_inside_floating(&win).unwrap_or(false);
                            if !focused && !inside {
                                collapse_peek_floating(&app);
                            }
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
            rename_label,
            remove_label,
            batch_move_list,
            batch_add_label,
            batch_complete_tasks,
            upload_task_attachment,
            download_task_attachment,
            remove_task_attachment,
            list_calendar_items,
            override_occurrence,
            clear_occurrence_override,
            get_occurrence_timeline,
            preview_repeat,
            list_notifications,
            mark_notification_read,
            snooze_reminder,
            notification_permission_state,
            request_notification_permission,
            send_test_notification,
            init_sticky_category,
            sync_sticky_notes,
            list_sticky_notes,
            get_sticky_note,
            create_sticky_note,
            update_sticky_note,
            delete_sticky_note,
            open_sticky_window,
            close_sticky_window,
            nas_file_space,
            nas_file_list,
            nas_search_files,
            nas_mkdir,
            nas_upload_file,
            nas_upload_paths,
            nas_download_file,
            nas_doctor,
            nas_system_overview,
            nas_list_events,
            nas_mark_events_read,
            nas_mark_all_events_read,
            nas_docker_list,
            nas_docker_stats,
            nas_docker_action,
            nas_docker_logs,
            nas_docker_images_list,
            nas_docker_compose_list,
            nas_download_tasks,
            nas_download_dirs,
            nas_download_add,
            nas_download_action,
            open_main_window,
            toggle_floating_window,
            dock_floating_window,
            peek_floating_window,
            collapse_peek_floating_window,
            set_floating_peek_hold,
            undock_floating_window,
            set_autostart,
            get_logs_dir,
            open_logs_dir,
            check_app_update,
            install_app_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ZSpace Kit")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = _event
            {
                let _ = open_main_window(_app.clone(), None);
            }
        });
}
