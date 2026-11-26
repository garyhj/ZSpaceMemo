mod logging;
mod scheduler;
mod updater;

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::{NotificationExt, PermissionState};
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
use zspace_memo_core::storage::{
    AppSettings, LocalStorage, NotificationRecord, WindowGeometryRecord,
};
use zspace_memo_core::toolbox::{SystemOverview, ToolboxService, UploadBatchSummary};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DockEdge {
    Left,
    Right,
    Top,
}

impl DockEdge {
    fn as_str(self) -> &'static str {
        match self {
            DockEdge::Left => "left",
            DockEdge::Right => "right",
            DockEdge::Top => "top",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "left" => Some(DockEdge::Left),
            "right" => Some(DockEdge::Right),
            "top" => Some(DockEdge::Top),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct FloatingDockPayload {
    edge: Option<DockEdge>,
    peeked: bool,
}

#[derive(Default)]
struct FloatingDockState {
    docked: Option<DockEdge>,
    peeked: bool,
    peek_hold: bool,
    peek_seq: u64,
    peek_pos: Option<PhysicalPosition<i32>>,
    tab_pos: Option<PhysicalPosition<i32>>,
    saved_pos: Option<PhysicalPosition<i32>>,
    saved_size: Option<PhysicalSize<u32>>,
    ignore_moves_until_ms: u64,
    move_seq: u64,
}

struct AppState {
    provider: Arc<OfficialCliNotebookProvider>,
    service: Arc<TaskService<OfficialCliNotebookProvider>>,
    sticky: Arc<StickyService<OfficialCliNotebookProvider>>,
    toolbox: Arc<ToolboxService>,
    storage: Arc<LocalStorage>,
    dock: Mutex<FloatingDockState>,
    tray: Mutex<Option<TrayIcon>>,
    geom_seqs: Mutex<HashMap<String, u64>>,
    geom_ignore_until_ms: Mutex<HashMap<String, u64>>,
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
    refresh_tray_tooltip(app);
}

fn emit_sticky_changed(app: &AppHandle, source_window: &WebviewWindow) {
    let _ = app.emit("sticky:changed", source_window.label());
}

fn permission_label(st: PermissionState) -> &'static str {
    match st {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "prompt",
    }
}

pub fn refresh_tray_tooltip(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let today = state
        .service
        .list_tasks(TaskView::Today, None, TaskSort::Date)
        .map(|v| v.len())
        .unwrap_or(0);
    let overdue = state
        .service
        .list_tasks(TaskView::Overdue, None, TaskSort::Date)
        .map(|v| v.len())
        .unwrap_or(0);
    let all = state
        .service
        .list_tasks(TaskView::All, None, TaskSort::Date)
        .map(|v| v.len())
        .unwrap_or(0);
    let tip = if all == 0 {
        "ZSpace Kit · 极空工具箱（暂无待办）".to_string()
    } else if overdue > 0 {
        format!("ZSpace Kit · 待办 {all} 项（含逾期 {overdue}）")
    } else {
        format!("ZSpace Kit · 今日 {today} · 待办 {all} 项")
    };
    if let Ok(guard) = state.tray.lock() {
        if let Some(tray) = guard.as_ref() {
            let _ = tray.set_tooltip(Some(&tip));
        }
    };
}

fn clamp_physical_rect_to_monitors(
    win: &WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    min_w: u32,
    min_h: u32,
) -> Option<(i32, i32, u32, u32)> {
    let monitors = win.available_monitors().ok()?;
    let fallback_wa = win
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned())?
        .work_area()
        .clone();

    let mut chosen_wa = None;
    let cx = x.saturating_add(width as i32 / 2);
    let cy = y.saturating_add(height as i32 / 2);
    for m in &monitors {
        let wa = m.work_area();
        let left = wa.position.x;
        let top = wa.position.y;
        let right = left + wa.size.width as i32;
        let bottom = top + wa.size.height as i32;
        if cx >= left && cx <= right && cy >= top && cy <= bottom {
            chosen_wa = Some(wa.clone());
            break;
        }
    }
    if chosen_wa.is_none() {
        let mut best_area = 0i64;
        for m in &monitors {
            let wa = m.work_area();
            let ox = (x + width as i32).min(wa.position.x + wa.size.width as i32) - x.max(wa.position.x);
            let oy =
                (y + height as i32).min(wa.position.y + wa.size.height as i32) - y.max(wa.position.y);
            if ox > 60 && oy > 60 {
                let area = ox as i64 * oy as i64;
                if area > best_area {
                    best_area = area;
                    chosen_wa = Some(wa.clone());
                }
            }
        }
    }
    let wa = chosen_wa.unwrap_or(fallback_wa);
    let wa_left = wa.position.x;
    let wa_top = wa.position.y;
    let wa_w = wa.size.width.max(min_w);
    let wa_h = wa.size.height.max(min_h);
    let w = width.clamp(min_w, wa_w);
    let h = height.clamp(min_h, wa_h);
    let max_x = wa_left + (wa_w as i32 - w as i32).max(0);
    let max_y = wa_top + (wa_h as i32 - h as i32).max(0);
    let nx = x.clamp(wa_left, max_x);
    let ny = y.clamp(wa_top, max_y);
    Some((nx, ny, w, h))
}

fn persist_floating_state(app: &AppHandle, override_visible: Option<bool>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(win) = app.get_webview_window("floating") else {
        return;
    };
    let visible = override_visible.unwrap_or_else(|| win.is_visible().unwrap_or(false));
    let mut dock = state.dock.lock().unwrap();
    if dock.docked.is_none() && !dock.peeked {
        if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
            if pos.x > -10000 && pos.y > -10000 && size.width >= 260 && size.height >= 260 {
                dock.saved_pos = Some(pos);
                dock.saved_size = Some(size);
            }
        }
    }
    let (Some(pos), Some(size)) = (dock.saved_pos, dock.saved_size) else {
        return;
    };
    let rec = WindowGeometryRecord {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        dock_edge: dock.docked.map(DockEdge::as_str).map(str::to_string),
        visible,
    };
    drop(dock);
    let _ = state.storage.save_window_geometry("floating", &rec);
}

fn mark_geom_ignore(app: &AppHandle, label: &str, ms: u64) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut map = state.geom_ignore_until_ms.lock().unwrap();
        map.insert(label.to_string(), now_ms() + ms);
    }
}

fn schedule_persist_window_geometry(app: AppHandle, label: String) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Ok(guard) = state.geom_ignore_until_ms.lock() {
        if let Some(&until) = guard.get(&label) {
            if now_ms() < until {
                return;
            }
        }
    }
    let seq = {
        let mut seqs = state.geom_seqs.lock().unwrap();
        let next = seqs.get(&label).copied().unwrap_or(0).wrapping_add(1);
        seqs.insert(label.clone(), next);
        next
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(450)).await;
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let still_latest = state
            .geom_seqs
            .lock()
            .unwrap()
            .get(&label)
            .copied()
            == Some(seq);
        if !still_latest {
            return;
        }
        let Some(win) = app.get_webview_window(&label) else {
            return;
        };
        if win.is_minimized().unwrap_or(false) {
            return;
        }
        if label == "main" && win.is_maximized().unwrap_or(false) {
            return;
        }
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            return;
        };
        if pos.x <= -10000 || pos.y <= -10000 || size.width < 150 || size.height < 150 {
            return;
        }
        let rec = WindowGeometryRecord {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            dock_edge: None,
            visible: true,
        };
        let _ = state.storage.save_window_geometry(&label, &rec);
    });
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
    let pos = win
        .outer_position()
        .unwrap_or(PhysicalPosition::new(wa_right - 370, wa_top + 80));
    let size = win.outer_size().unwrap_or(PhysicalSize::new(350, 520));

    let edge = edge_hint.unwrap_or_else(|| {
        let center_x = pos.x + size.width as i32 / 2;
        if (center_x - wa_left) < (wa_right - center_x) {
            DockEdge::Left
        } else {
            DockEdge::Right
        }
    });

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

    {
        let state = app.state::<AppState>();
        let mut dock = state.dock.lock().unwrap();
        if dock.docked.is_none() {
            dock.saved_pos = Some(pos);
            dock.saved_size = Some(size);
        }
        dock.docked = Some(edge);
        dock.peeked = false;
        dock.peek_hold = false;
        dock.peek_seq += 1;
        dock.peek_pos = None;
        dock.tab_pos = Some(PhysicalPosition::new(nx, ny));
        dock.ignore_moves_until_ms = now_ms() + 800;
    }

    let _ = win.set_min_size(None::<LogicalSize<u32>>);
    let _ = win.set_resizable(false);
    let _ = win.set_size(LogicalSize::new(lw, lh));
    let _ = win.set_position(PhysicalPosition::new(nx, ny));
    let _ = win.emit(
        "floating:dock-changed",
        FloatingDockPayload {
            edge: Some(edge),
            peeked: false,
        },
    );
    persist_floating_state(app, Some(true));
}

fn is_cursor_inside_floating(win: &WebviewWindow) -> Option<bool> {
    let cursor = win.cursor_position().ok()?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let margin = (8.0 * scale).round();

    Some(
        cursor.x >= (pos.x as f64 - margin)
            && cursor.x <= (pos.x as f64 + size.width as f64 + margin)
            && cursor.y >= (pos.y as f64 - margin)
            && cursor.y <= (pos.y as f64 + size.height as f64 + margin),
    )
}

fn start_peek_cursor_monitor(app: AppHandle, seq: u64) {
    tauri::async_runtime::spawn(async move {
        // Allow OS window resize/reposition to settle before polling cursor exit.
        tokio::time::sleep(Duration::from_millis(320)).await;
        let mut outside_streak = 0u8;

        loop {
            tokio::time::sleep(Duration::from_millis(120)).await;

            let (active, hold) = {
                let state = app.state::<AppState>();
                let dock = state.dock.lock().unwrap();
                (
                    dock.docked.is_some() && dock.peeked && dock.peek_seq == seq,
                    dock.peek_hold,
                )
            };
            if !active {
                break;
            }

            let Some(win) = app.get_webview_window("floating") else {
                break;
            };
            if !win.is_visible().unwrap_or(false) {
                break;
            }

            let is_focused = win.is_focused().unwrap_or(false);
            if hold && is_focused {
                outside_streak = 0;
                continue;
            }

            let Some(inside) = is_cursor_inside_floating(&win) else {
                continue;
            };

            if inside {
                outside_streak = 0;
            } else {
                outside_streak = outside_streak.saturating_add(1);
                if outside_streak >= 2 {
                    collapse_peek_floating(&app);
                    break;
                }
            }
        }
    });
}

fn peek_floating(app: &AppHandle) {
    let Some(win) = app.get_webview_window("floating") else {
        return;
    };
    let cur_pos = win.outer_position().ok();
    let (wa_left, wa_top, wa_right, wa_bottom, scale) =
        monitor_work_area(&win).unwrap_or((0, 0, 1440, 900, 1.0));

    let (edge, target_size, nx, ny, seq) = {
        let state = app.state::<AppState>();
        let mut dock = state.dock.lock().unwrap();
        let Some(edge) = dock.docked else {
            return;
        };
        if dock.peeked {
            return;
        }
        if dock.tab_pos.is_none() {
            dock.tab_pos = cur_pos;
        }
        let target_size = dock.saved_size.unwrap_or_else(|| {
            PhysicalSize::new(
                (350.0 * scale).round() as u32,
                (520.0 * scale).round() as u32,
            )
        });
        let exp_w = target_size.width as i32;
        let exp_h = target_size.height as i32;
        let base = dock
            .tab_pos
            .or(cur_pos)
            .unwrap_or(PhysicalPosition::new(wa_right - 38, wa_top + 80));

        let (nx, ny) = match edge {
            DockEdge::Left => (
                wa_left,
                base.y.clamp(wa_top + 8, (wa_bottom - exp_h - 8).max(wa_top)),
            ),
            DockEdge::Right => (
                wa_right - exp_w,
                base.y.clamp(wa_top + 8, (wa_bottom - exp_h - 8).max(wa_top)),
            ),
            DockEdge::Top => (
                base.x.clamp(wa_left + 8, (wa_right - exp_w - 8).max(wa_left)),
                wa_top,
            ),
        };

        dock.peeked = true;
        dock.peek_hold = false;
        dock.peek_seq += 1;
        dock.peek_pos = Some(PhysicalPosition::new(nx, ny));
        dock.ignore_moves_until_ms = now_ms() + 650;
        (edge, target_size, nx, ny, dock.peek_seq)
    };

    let _ = win.set_resizable(true);
    let _ = win.set_min_size(Some(LogicalSize::new(300_u32, 360_u32)));
    let _ = win.set_size(target_size);
    let _ = win.set_position(PhysicalPosition::new(nx, ny));
    let _ = win.show();
    let _ = win.emit(
        "floating:dock-changed",
        FloatingDockPayload {
            edge: Some(edge),
            peeked: true,
        },
    );
    start_peek_cursor_monitor(app.clone(), seq);
}

fn collapse_peek_floating(app: &AppHandle) {
    let Some(win) = app.get_webview_window("floating") else {
        return;
    };
    let (edge, tab_pos) = {
        let state = app.state::<AppState>();
        let mut dock = state.dock.lock().unwrap();
        let Some(edge) = dock.docked else {
            return;
        };
        if !dock.peeked {
            return;
        }
        dock.peeked = false;
        dock.peek_hold = false;
        dock.peek_seq += 1;
        dock.peek_pos = None;
        dock.ignore_moves_until_ms = now_ms() + 800;
        (edge, dock.tab_pos)
    };

    let (wa_left, wa_top, wa_right, wa_bottom, scale) =
        monitor_work_area(&win).unwrap_or((0, 0, 1440, 900, 1.0));
    let (lw, lh) = match edge {
        DockEdge::Left | DockEdge::Right => (38_u32, 124_u32),
        DockEdge::Top => (144_u32, 34_u32),
    };
    let pw = (lw as f64 * scale).round() as i32;
    let ph = (lh as f64 * scale).round() as i32;
    let cur_pos = win.outer_position().ok();
    let base = tab_pos
        .or(cur_pos)
        .unwrap_or(PhysicalPosition::new(wa_right - pw, wa_top + 80));

    let (nx, ny) = match edge {
        DockEdge::Left => (
            wa_left,
            base.y.clamp(wa_top + 12, (wa_bottom - ph - 12).max(wa_top)),
        ),
        DockEdge::Right => (
            wa_right - pw,
            base.y.clamp(wa_top + 12, (wa_bottom - ph - 12).max(wa_top)),
        ),
        DockEdge::Top => (
            base.x.clamp(wa_left + 12, (wa_right - pw - 12).max(wa_left)),
            wa_top,
        ),
    };

    let _ = win.set_min_size(None::<LogicalSize<u32>>);
    let _ = win.set_resizable(false);
    let _ = win.set_size(LogicalSize::new(lw, lh));
    let _ = win.set_position(PhysicalPosition::new(nx, ny));
    let _ = win.emit(
        "floating:dock-changed",
        FloatingDockPayload {
            edge: Some(edge),
            peeked: false,
        },
    );
}

fn undock_floating(app: &AppHandle) {
    let Some(win) = app.get_webview_window("floating") else {
        return;
    };
    let (edge, tab_pos, saved_pos, saved_size) = {
        let state = app.state::<AppState>();
        let mut dock = state.dock.lock().unwrap();
        let edge = dock.docked.take();
        dock.peeked = false;
        dock.peek_hold = false;
        dock.peek_seq += 1;
        dock.peek_pos = None;
        let tab_pos = dock.tab_pos.take();
        dock.ignore_moves_until_ms = now_ms() + 1000;
        (edge, tab_pos, dock.saved_pos, dock.saved_size)
    };

    let cur_pos = win.outer_position().ok();
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
    // Shift noticeably away from the screen edge (> 20px dock threshold) when clicking to undock.
    let gap = (48.0 * scale).round() as i32;

    let base = tab_pos
        .or(cur_pos)
        .or(saved_pos)
        .unwrap_or(PhysicalPosition::new(wa_right - exp_w - gap, wa_top + 80));
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
    let _ = win.emit(
        "floating:dock-changed",
        FloatingDockPayload {
            edge: None,
            peeked: false,
        },
    );
    let _ = win.emit("floating:focus-input", ());
    persist_floating_state(app, Some(true));
}

async fn ensure_sticky_window(app: &AppHandle, id: i64) -> Result<(), String> {
    let label = format!("sticky-{id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let offset = ((id.abs() % 5) as f64) * 28.0;
    let win = WebviewWindowBuilder::new(
        app,
        label.clone(),
        WebviewUrl::App(format!("/?mode=sticky&id={id}").into()),
    )
    .title("ZSpace Kit · 便签")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(280.0, 320.0)
    .min_inner_size(220.0, 220.0)
    .position(920.0 + offset, 120.0 + offset)
    .build()
    .map_err(|e| e.to_string())?;

    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(Some(rec)) = state.storage.load_window_geometry(&label) {
            if let Some((nx, ny, w, h)) =
                clamp_physical_rect_to_monitors(&win, rec.x, rec.y, rec.width, rec.height, 220, 220)
            {
                mark_geom_ignore(app, &label, 700);
                let _ = win.set_size(PhysicalSize::new(w, h));
                let _ = win.set_position(PhysicalPosition::new(nx, ny));
            }
        }
    }
    Ok(())
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
async fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
    let prev = state.storage.load_settings().ok();
    let normalized = settings.normalized_and_validated().map_err(map_err)?;
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
fn ensure_windows_aumid(app: Option<&AppHandle>) {
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
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
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
        .run(tauri::generate_context!())
        .expect("error while running ZSpace Kit");
}
