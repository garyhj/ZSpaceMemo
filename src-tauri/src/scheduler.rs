use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};
use zspace_memo_core::provider::official_cli::OfficialCliNotebookProvider;
use zspace_memo_core::service::TaskService;
use zspace_memo_core::sticky::StickyService;
use zspace_memo_core::toolbox::ToolboxService;

/// Background Tokio loop:
/// - Syncs tasks, sticky notes & NAS events on startup and every `sync_interval_secs`
/// - Checks due reminder jobs every 15s (including missed-while-powered-off catch-up)
/// - Fires OS native notifications for tasks and newly arrived NAS alerts
pub fn spawn_background_scheduler(
    app: AppHandle,
    service: Arc<TaskService<OfficialCliNotebookProvider>>,
    sticky: Arc<StickyService<OfficialCliNotebookProvider>>,
    toolbox: Arc<ToolboxService>,
) {
    tauri::async_runtime::spawn(async move {
        let mut sync_elapsed = 9999u64; // Trigger immediate sync on boot.
        let mut ticker = tokio::time::interval(Duration::from_secs(15));

        loop {
            ticker.tick().await;
            let cfg = service.get_settings().unwrap_or_default();
            let interval = cfg.sync_interval_secs.max(30);

            if sync_elapsed >= interval {
                sync_elapsed = 0;
                match service.sync().await {
                    Ok(summary) => {
                        info!(
                            total = summary.total_notes,
                            fetched = summary.fetched_details,
                            recovered = summary.recovered_count,
                            "background task sync ok"
                        );
                        let _ = app.emit("tasks:synced", &summary);
                        crate::refresh_tray_tooltip(&app);
                    }
                    Err(e) => {
                        warn!(error = %e, "background task sync skipped/failed");
                    }
                }
                match sticky.sync().await {
                    Ok(fetched) => {
                        let _ = app.emit("sticky:synced", fetched);
                    }
                    Err(e) => {
                        warn!(error = %e, "background sticky sync skipped/failed");
                    }
                }
                if cfg.bridge_nas_events {
                    match toolbox.poll_new_nas_notifications().await {
                        Ok(events) => {
                            if !events.is_empty() {
                                let _ = app.emit("nas:events-updated", &events);
                            }
                            for ev in events {
                                if let Err(e) = crate::send_native_notification(
                                    &app,
                                    &format!("极空间通知 · {}", ev.title),
                                    &ev.body,
                                    cfg.notification_sound,
                                ) {
                                    warn!(error = %e, "NAS bridged notification show failed");
                                }
                            }
                        }
                        Err(e) => {
                            warn!(error = %e, "NAS events poll skipped/failed");
                        }
                    }
                }
            } else {
                sync_elapsed += 15;
            }

            match service.process_due_reminders().await {
                Ok(fired) => {
                    for notif in fired {
                        if let Err(e) = crate::send_native_notification(
                            &app,
                            &notif.title,
                            &notif.body,
                            cfg.notification_sound,
                        ) {
                            warn!(error = %e, title = %notif.title, "OS notification show failed");
                        }
                        let _ = app.emit("reminder:fired", &notif);
                    }
                }
                Err(e) => {
                    warn!(error = %e, "reminder check failed");
                }
            }
        }
    });
}
