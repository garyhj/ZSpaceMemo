use chrono::{DateTime, Utc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::time::MissedTickBehavior;
use tracing::{info, warn};
use zspace_memo_core::provider::official_cli::OfficialCliNotebookProvider;
use zspace_memo_core::service::TaskService;
use zspace_memo_core::sticky::StickyService;
use zspace_memo_core::toolbox::ToolboxService;

/// Background Tokio scheduler:
/// - Recovers stale `'firing'` jobs and prunes old records on boot
/// - Triggers wall-clock-scheduled NAS syncs asynchronously (handles laptop sleep/wake)
/// - Checks due local reminders every 15s without waiting on slow network syncs
pub fn spawn_background_scheduler(
    app: AppHandle,
    service: Arc<TaskService<OfficialCliNotebookProvider>>,
    sticky: Arc<StickyService<OfficialCliNotebookProvider>>,
    toolbox: Arc<ToolboxService>,
) {
    tauri::async_runtime::spawn(async move {
        let now_ts = Utc::now().timestamp();
        if let Ok(recovered) = service.storage().recover_stale_firing_jobs(now_ts - 60) {
            if recovered > 0 {
                info!(recovered, "recovered stale firing reminder jobs on boot");
            }
        }
        let _ = service.storage().prune_old_records(60);

        let sync_in_flight = Arc::new(AtomicBool::new(false));
        let mut last_sync_utc: Option<DateTime<Utc>> = None;
        let mut last_offline_reconcile: Option<DateTime<Utc>> = None;

        let mut ticker = tokio::time::interval(Duration::from_secs(15));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            let now = Utc::now();
            let cfg = service.get_settings().unwrap_or_default();
            let interval_secs = cfg.sync_interval_secs.max(30) as i64;

            let due_for_sync = match last_sync_utc {
                None => true,
                Some(prev) => (now - prev).num_seconds() >= interval_secs,
            };

            if due_for_sync && !sync_in_flight.swap(true, Ordering::SeqCst) {
                last_sync_utc = Some(now);
                let flag = sync_in_flight.clone();
                let app_sync = app.clone();
                let svc = service.clone();
                let stk = sticky.clone();
                let tb = toolbox.clone();
                let sound = cfg.notification_sound;
                let bridge = cfg.bridge_nas_events;
                tauri::async_runtime::spawn(async move {
                    struct ResetGuard(Arc<AtomicBool>);
                    impl Drop for ResetGuard {
                        fn drop(&mut self) {
                            self.0.store(false, Ordering::SeqCst);
                        }
                    }
                    let _guard = ResetGuard(flag);

                    match svc.sync().await {
                        Ok(summary) => {
                            info!(
                                total = summary.total_notes,
                                fetched = summary.fetched_details,
                                recovered = summary.recovered_count,
                                "background task sync ok"
                            );
                            let _ = app_sync.emit("tasks:synced", &summary);
                            crate::refresh_tray_tooltip(&app_sync);
                        }
                        Err(e) => {
                            warn!(error = %e, "background task sync skipped/failed");
                            let _ = svc.reconcile_all_cached_reminders();
                        }
                    }
                    match stk.sync().await {
                        Ok(fetched) => {
                            let _ = app_sync.emit("sticky:synced", fetched);
                        }
                        Err(e) => {
                            warn!(error = %e, "background sticky sync skipped/failed");
                        }
                    }
                    if bridge {
                        match tb.poll_new_nas_notifications().await {
                            Ok(events) => {
                                if !events.is_empty() {
                                    let _ = app_sync.emit("nas:events-updated", &events);
                                }
                                for ev in events {
                                    if let Err(e) = crate::send_native_notification(
                                        &app_sync,
                                        &format!("极空间通知 · {}", ev.title),
                                        &ev.body,
                                        sound,
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
                });
            } else if last_offline_reconcile
                .map(|p| (now - p).num_seconds() >= 1800)
                .unwrap_or(false)
            {
                last_offline_reconcile = Some(now);
                let _ = service.reconcile_all_cached_reminders();
            }
            if last_offline_reconcile.is_none() {
                last_offline_reconcile = Some(now);
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
