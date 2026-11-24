use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tracing::{info, warn};
use zspace_memo_core::provider::official_cli::OfficialCliNotebookProvider;
use zspace_memo_core::service::TaskService;

/// Background Tokio loop:
/// - Syncs from NAS on startup and every `sync_interval_secs` (default 5m)
/// - Checks due reminder jobs every 15s (including missed-while-powered-off catch-up)
/// - Emits OS native notifications + frontend events
pub fn spawn_background_scheduler(
    app: AppHandle,
    service: Arc<TaskService<OfficialCliNotebookProvider>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut sync_elapsed = 9999u64; // Trigger immediate sync on boot.
        let mut ticker = tokio::time::interval(Duration::from_secs(15));

        loop {
            ticker.tick().await;
            let interval = service
                .get_settings()
                .map(|s| s.sync_interval_secs.max(30))
                .unwrap_or(300);

            if sync_elapsed >= interval {
                sync_elapsed = 0;
                match service.sync().await {
                    Ok(summary) => {
                        info!(
                            total = summary.total_notes,
                            fetched = summary.fetched_details,
                            recovered = summary.recovered_count,
                            "background sync ok"
                        );
                        let _ = app.emit("tasks:synced", &summary);
                    }
                    Err(e) => {
                        warn!(error = %e, "background sync skipped/failed");
                    }
                }
            } else {
                sync_elapsed += 15;
            }

            match service.process_due_reminders().await {
                Ok(fired) => {
                    for notif in fired {
                        let _ = app
                            .notification()
                            .builder()
                            .title(&notif.title)
                            .body(&notif.body)
                            .show();
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
