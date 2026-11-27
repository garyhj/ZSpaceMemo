use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri_plugin_notification::PermissionState;
use zspace_memo_core::models::TaskSort;
use zspace_memo_core::provider::official_cli::OfficialCliNotebookProvider;
use zspace_memo_core::service::TaskService;
use zspace_memo_core::sticky::StickyService;
use zspace_memo_core::storage::LocalStorage;
use zspace_memo_core::toolbox::ToolboxService;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DockEdge {
    Left,
    Right,
    Top,
}

impl DockEdge {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            DockEdge::Left => "left",
            DockEdge::Right => "right",
            DockEdge::Top => "top",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Self> {
        match s {
            "left" => Some(DockEdge::Left),
            "right" => Some(DockEdge::Right),
            "top" => Some(DockEdge::Top),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct FloatingDockPayload {
    pub(crate) edge: Option<DockEdge>,
    pub(crate) peeked: bool,
}

#[derive(Default)]
pub(crate) struct FloatingDockState {
    pub(crate) docked: Option<DockEdge>,
    pub(crate) peeked: bool,
    pub(crate) peek_hold: bool,
    pub(crate) peek_seq: u64,
    pub(crate) peek_pos: Option<PhysicalPosition<i32>>,
    pub(crate) tab_pos: Option<PhysicalPosition<i32>>,
    pub(crate) saved_pos: Option<PhysicalPosition<i32>>,
    pub(crate) saved_size: Option<PhysicalSize<u32>>,
    pub(crate) ignore_moves_until_ms: u64,
    pub(crate) move_seq: u64,
}

pub(crate) struct AppState {
    pub(crate) provider: Arc<OfficialCliNotebookProvider>,
    pub(crate) service: Arc<TaskService<OfficialCliNotebookProvider>>,
    pub(crate) sticky: Arc<StickyService<OfficialCliNotebookProvider>>,
    pub(crate) toolbox: Arc<ToolboxService>,
    pub(crate) storage: Arc<LocalStorage>,
    pub(crate) dock: Mutex<FloatingDockState>,
    pub(crate) tray: Mutex<Option<TrayIcon>>,
    pub(crate) geom_seqs: Mutex<HashMap<String, u64>>,
    pub(crate) geom_ignore_until_ms: Mutex<HashMap<String, u64>>,
}

#[derive(Serialize)]
pub(crate) struct RepeatPreview {
    pub(crate) description: String,
    pub(crate) dates: Vec<String>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn map_err(e: zspace_memo_core::error::AppError) -> String {
    serde_json::to_string(&e.to_payload()).unwrap_or_else(|_| e.to_string())
}

pub(crate) fn emit_changed(app: &AppHandle, source_window: &WebviewWindow) {
    let _ = app.emit("tasks:changed", source_window.label());
    refresh_tray_tooltip(app);
}

pub(crate) fn emit_sticky_changed(app: &AppHandle, source_window: &WebviewWindow) {
    let _ = app.emit("sticky:changed", source_window.label());
}

pub(crate) fn permission_label(st: PermissionState) -> &'static str {
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
        .list_tasks(zspace_memo_core::models::TaskView::Today, None, TaskSort::Date)
        .map(|v| v.len())
        .unwrap_or(0);
    let overdue = state
        .service
        .list_tasks(zspace_memo_core::models::TaskView::Overdue, None, TaskSort::Date)
        .map(|v| v.len())
        .unwrap_or(0);
    let all = state
        .service
        .list_tasks(zspace_memo_core::models::TaskView::All, None, TaskSort::Date)
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
