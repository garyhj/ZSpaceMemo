use super::*;
use crate::codec::due_point;
use crate::models::{
    CreateTaskInput, OccurrenceActionStatus, Priority, Reminder, RepeatEnd, RepeatFreq, RepeatRule,
    Schedule, TaskStatus, UpdateTaskInput,
};
use crate::provider::mock::MockNotebookProvider;
use crate::recurrence::format_date;
use chrono::Duration;

async fn setup() -> (TaskService<MockNotebookProvider>, Arc<MockNotebookProvider>) {
    let provider = Arc::new(MockNotebookProvider::new());
    let storage = Arc::new(LocalStorage::open_in_memory().unwrap());
    let svc = TaskService::new(provider.clone(), storage);
    svc.initialize_todo_category(true).await.unwrap();
    (svc, provider)
}

#[tokio::test]
async fn full_crud_conflict_and_auto_recovery() {
    let (svc, provider) = setup().await;

    let created = svc
        .create_task(CreateTaskInput {
            title: "续费 eSIM".into(),
            description: "核对套餐".into(),
            priority: Priority::High,
            list: Some("个人".into()),
            labels: vec!["续费".into()],
            pinned: false,
            schedule: Schedule {
                all_day: false,
                due: Some(due_point("2026-11-26", Some("18:00"))),
                timezone: "Asia/Shanghai".into(),
            },
            reminders: vec![Reminder::Relative {
                id: "r1".into(),
                offset_minutes: Some(-60),
                offset_days: None,
                day_time: None,
            }],
            repeat: Some(RepeatRule {
                freq: RepeatFreq::Monthly,
                interval: 6,
                calendar: Default::default(),
                by_weekday: None,
                by_set_pos: None,
                by_month_day: Some(vec![26]),
                by_month: None,
                lunar: None,
                day_filter: None,
                on_invalid_date: Default::default(),
                basis: Default::default(),
                catch_up: Default::default(),
                end: Default::default(),
                dtstart: "2026-11-26".into(),
            }),
        })
        .await
        .unwrap();

    assert_eq!(created.status, TaskStatus::Active);
    assert_eq!(created.series.as_ref().unwrap().cursor, "2026-11-26");

    // Idempotent occurrence completion advances cursor to 2027-05-26.
    let after_done = svc
        .act_on_occurrence(
            created.id,
            Some("2026-11-26"),
            OccurrenceActionStatus::Completed,
        )
        .await
        .unwrap();
    assert_eq!(after_done.series.as_ref().unwrap().cursor, "2027-05-26");
    assert_eq!(after_done.series.as_ref().unwrap().history.len(), 1);

    // Second call with same key is idempotent.
    let idempotent = svc
        .act_on_occurrence(
            created.id,
            Some("2026-11-26"),
            OccurrenceActionStatus::Completed,
        )
        .await
        .unwrap();
    assert_eq!(idempotent.series.as_ref().unwrap().cursor, "2027-05-26");
    assert_eq!(idempotent.series.as_ref().unwrap().history.len(), 1);

    // Stale ETag update returns TaskConflict.
    let err = svc
        .update_task(
            created.id,
            UpdateTaskInput {
                title: Some("改名".into()),
                etag: Some(created.etag.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::TaskConflict { .. }));

    // Simulate official app corrupting the ZSM1 block while editing description.
    provider
        .simulate_external_edit(
            created.id,
            "续费 eSIM",
            "<h1>续费 eSIM</h1><p>摘要</p><hr><p>官方改过的新备注</p><hr><p>ZSM1:{broken</p>",
        )
        .await;

    let summary = svc.sync().await.unwrap();
    assert_eq!(summary.recovered_count, 1);

    // Metadata (repeat + reminders + history) is recovered AND user's new description is kept!
    let recovered = svc.get_task(created.id, false).await.unwrap();
    assert_eq!(recovered.description, "官方改过的新备注");
    assert_eq!(recovered.reminders.len(), 1);
    assert_eq!(recovered.repeat.as_ref().unwrap().interval, 6);
    assert_eq!(recovered.series.as_ref().unwrap().cursor, "2027-05-26");
}

#[tokio::test]
async fn calendar_expansion_and_single_occurrence_override() {
    let (svc, _provider) = setup().await;

    let weekly = svc
        .create_task(CreateTaskInput {
            title: "每周一例会".into(),
            description: String::new(),
            priority: Priority::Normal,
            list: Some("工作".into()),
            labels: vec![],
            pinned: false,
            schedule: Schedule {
                all_day: false,
                due: Some(due_point("2026-11-02", Some("10:00"))),
                timezone: "Asia/Shanghai".into(),
            },
            reminders: vec![],
            repeat: Some(RepeatRule {
                freq: RepeatFreq::Weekly,
                interval: 1,
                calendar: Default::default(),
                by_weekday: Some(vec!["MO".into()]),
                by_set_pos: None,
                by_month_day: None,
                by_month: None,
                lunar: None,
                day_filter: None,
                on_invalid_date: Default::default(),
                basis: Default::default(),
                catch_up: Default::default(),
                end: Default::default(),
                dtstart: "2026-11-02".into(),
            }),
        })
        .await
        .unwrap();

    let items = svc
        .list_calendar_items("2026-11-01", "2026-11-30", true)
        .unwrap();
    let dates: Vec<&str> = items.iter().map(|i| i.date.as_str()).collect();
    assert_eq!(
        dates,
        vec![
            "2026-11-02",
            "2026-11-09",
            "2026-11-16",
            "2026-11-23",
            "2026-11-30"
        ]
    );

    // Drag-reschedule only the 2026-11-16 occurrence to 2026-11-17.
    svc.override_occurrence(weekly.id, "2026-11-16", "2026-11-17", None)
        .await
        .unwrap();

    let items_after = svc
        .list_calendar_items("2026-11-01", "2026-11-30", true)
        .unwrap();
    let dates_after: Vec<&str> = items_after.iter().map(|i| i.date.as_str()).collect();
    assert_eq!(
        dates_after,
        vec![
            "2026-11-02",
            "2026-11-09",
            "2026-11-17",
            "2026-11-23",
            "2026-11-30"
        ]
    );

    // Clear the single-instance override and ensure it snaps back to 2026-11-16.
    svc.clear_occurrence_override(weekly.id, "2026-11-16")
        .await
        .unwrap();
    let items_restored = svc
        .list_calendar_items("2026-11-01", "2026-11-30", true)
        .unwrap();
    let dates_restored: Vec<&str> = items_restored.iter().map(|i| i.date.as_str()).collect();
    assert_eq!(
        dates_restored,
        vec![
            "2026-11-02",
            "2026-11-09",
            "2026-11-16",
            "2026-11-23",
            "2026-11-30"
        ]
    );
}

#[tokio::test]
async fn task_attachments_upload_download_and_remove() {
    let (svc, _provider) = setup().await;
    let task = svc
        .create_task(CreateTaskInput {
            title: "报销单".into(),
            description: "附发票 PDF".into(),
            priority: Priority::Normal,
            list: None,
            labels: vec![],
            pinned: false,
            schedule: Schedule::default(),
            reminders: vec![],
            repeat: None,
        })
        .await
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let src_file = dir.path().join("receipt.txt");
    std::fs::write(&src_file, b"invoice-12345").unwrap();

    let updated = svc
        .upload_task_attachment(task.id, src_file.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(updated.attachments.len(), 1);
    assert_eq!(updated.attachments[0].name, "receipt.txt");
    assert_eq!(updated.attachments[0].size, Some(13));
    let fid = updated.attachments[0].file_id.clone();

    // Reload directly from provider and ensure ZSM1 preserved attachment metadata.
    let reloaded = svc.get_task(task.id, true).await.unwrap();
    assert_eq!(reloaded.attachments.len(), 1);
    assert_eq!(reloaded.attachments[0].file_id, fid);

    let dest_file = dir.path().join("downloaded.txt");
    svc.download_task_attachment(task.id, &fid, dest_file.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest_file).unwrap(), b"invoice-12345");

    let removed = svc.remove_task_attachment(task.id, &fid).await.unwrap();
    assert!(removed.attachments.is_empty());
}

#[tokio::test]
async fn sync_cancels_pending_reminders_for_remotely_deleted_task_and_recovers_stale_firing() {
    let (svc, provider) = setup().await;
    let past_due = (Utc::now() - Duration::minutes(1)).to_rfc3339();
    let task = svc
        .create_task(CreateTaskInput {
            title: "会被远端删除的提醒".into(),
            description: String::new(),
            priority: Priority::Normal,
            list: None,
            labels: vec![],
            pinned: false,
            schedule: Schedule {
                all_day: false,
                due: Some(due_point(&format_date(Utc::now().date_naive()), None)),
                timezone: "UTC".into(),
            },
            reminders: vec![Reminder::Absolute {
                id: "abs1".into(),
                at: past_due,
            }],
            repeat: None,
        })
        .await
        .unwrap();

    // Delete directly on NAS provider (bypassing local TaskService::delete_task).
    provider.delete_note(task.id).await.unwrap();
    svc.sync().await.unwrap();

    // Remote delete must cancel pending jobs so no zombie reminder fires.
    let fired = svc.process_due_reminders().await.unwrap();
    assert!(fired.is_empty());

    // Snooze + simulate stale 'firing' job from a crash/update exit -> recover_stale_firing_jobs restores it.
    let job_key = svc
        .storage()
        .add_snooze_job(
            999_999,
            "single",
            Utc::now() - Duration::minutes(1),
            "Crash test",
            "Body",
        )
        .unwrap();
    let claimed = svc
        .storage()
        .claim_due_jobs(Utc::now().timestamp())
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].job_key, job_key);

    let recovered = svc
        .storage()
        .recover_stale_firing_jobs(Utc::now().timestamp() + 1)
        .unwrap();
    assert_eq!(recovered, 1);
    let re_claimed = svc
        .storage()
        .claim_due_jobs(Utc::now().timestamp())
        .unwrap();
    assert_eq!(re_claimed.len(), 1);
}

#[tokio::test]
async fn reopen_ended_series_handles_manual_and_count_end_and_computes_effective_key() {
    let (svc, _provider) = setup().await;
    let today_naive = Utc::now()
        .with_timezone(&chrono_tz::Asia::Shanghai)
        .date_naive();
    let today = format_date(today_naive);
    let past_start = format_date(today_naive - Duration::days(10));
    let manual_task = svc
        .create_task(CreateTaskInput {
            title: "手动终止系列".into(),
            description: String::new(),
            priority: Priority::Normal,
            list: None,
            labels: vec![],
            pinned: false,
            schedule: Schedule {
                all_day: true,
                due: Some(due_point(&past_start, None)),
                timezone: "Asia/Shanghai".into(),
            },
            reminders: vec![],
            repeat: Some(RepeatRule {
                freq: RepeatFreq::Daily,
                interval: 1,
                calendar: Default::default(),
                by_weekday: None,
                by_set_pos: None,
                by_month_day: None,
                by_month: None,
                lunar: None,
                day_filter: None,
                on_invalid_date: Default::default(),
                basis: Default::default(),
                catch_up: crate::models::CatchUpPolicy::Latest,
                end: RepeatEnd::Never,
                dtstart: past_start,
            }),
        })
        .await
        .unwrap();

    // Catch-up 'latest' should advance effective_current_key to today instead of 10 days ago.
    assert_eq!(
        manual_task.effective_current_key.as_deref(),
        Some(today.as_str())
    );
    assert_eq!(manual_task.is_overdue, Some(false));

    let ended = svc.end_series(manual_task.id).await.unwrap();
    assert_eq!(ended.status, TaskStatus::Ended);
    let resumed = svc.reopen_task(manual_task.id, None).await.unwrap();
    assert_eq!(resumed.status, TaskStatus::Active);
    assert!(resumed.series.unwrap().ended_at.is_none());

    // Count=1 series ends after 1 completion; reopening restores cursor & clears completion.
    let limited = svc
        .create_task(CreateTaskInput {
            title: "仅一次循环".into(),
            description: String::new(),
            priority: Priority::Normal,
            list: None,
            labels: vec![],
            pinned: false,
            schedule: Schedule {
                all_day: true,
                due: Some(due_point(&today, None)),
                timezone: "Asia/Shanghai".into(),
            },
            reminders: vec![],
            repeat: Some(RepeatRule {
                freq: RepeatFreq::Daily,
                interval: 1,
                calendar: Default::default(),
                by_weekday: None,
                by_set_pos: None,
                by_month_day: None,
                by_month: None,
                lunar: None,
                day_filter: None,
                on_invalid_date: Default::default(),
                basis: Default::default(),
                catch_up: crate::models::CatchUpPolicy::Latest,
                end: RepeatEnd::Count { count: 1 },
                dtstart: today.clone(),
            }),
        })
        .await
        .unwrap();
    let done_limited = svc
        .act_on_occurrence(limited.id, None, OccurrenceActionStatus::Completed)
        .await
        .unwrap();
    assert_eq!(done_limited.status, TaskStatus::Ended);
    let reopened_limited = svc.reopen_task(limited.id, None).await.unwrap();
    assert_eq!(reopened_limited.status, TaskStatus::Active);
    assert!(reopened_limited.series.unwrap().history.is_empty());
}
