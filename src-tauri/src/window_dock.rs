use crate::state::{now_ms, AppState, DockEdge, FloatingDockPayload};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use zspace_memo_core::storage::WindowGeometryRecord;

pub(crate) fn clamp_physical_rect_to_monitors(
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

pub(crate) fn persist_floating_state(app: &AppHandle, override_visible: Option<bool>) {
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

pub(crate) fn mark_geom_ignore(app: &AppHandle, label: &str, ms: u64) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut map = state.geom_ignore_until_ms.lock().unwrap();
        map.insert(label.to_string(), now_ms() + ms);
    }
}

pub(crate) fn schedule_persist_window_geometry(app: AppHandle, label: String) {
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

pub(crate) fn monitor_work_area(win: &WebviewWindow) -> Option<(i32, i32, i32, i32, f64)> {
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

pub(crate) fn dock_floating(app: &AppHandle, edge_hint: Option<DockEdge>) {
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

pub(crate) fn is_cursor_inside_floating(win: &WebviewWindow) -> Option<bool> {
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

pub(crate) fn start_peek_cursor_monitor(app: AppHandle, seq: u64) {
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

pub(crate) fn peek_floating(app: &AppHandle) {
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

pub(crate) fn collapse_peek_floating(app: &AppHandle) {
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

pub(crate) fn undock_floating(app: &AppHandle) {
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

pub(crate) async fn ensure_sticky_window(app: &AppHandle, id: i64) -> Result<(), String> {
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
