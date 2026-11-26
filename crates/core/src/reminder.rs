use crate::models::{Reminder, Schedule};
use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use sha2::{Digest, Sha256};

/// A materialized reminder fire event ready to be stored in SQLite `reminder_jobs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputedReminderJob {
    pub job_key: String,
    pub task_id: i64,
    pub occurrence_key: String,
    pub reminder_id: String,
    pub fire_at_utc: DateTime<Utc>,
    pub title: String,
    pub body: String,
}

/// Deterministic job key for deduplication across syncs and restarts.
pub fn compute_job_key(
    task_id: i64,
    occurrence_key: &str,
    reminder_id: &str,
    fire_at_utc: DateTime<Utc>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "{task_id}|{occurrence_key}|{reminder_id}|{}",
        fire_at_utc.timestamp()
    ));
    let digest = hasher.finalize();
    format!("{:x}", digest)[..24].to_string()
}

/// Convert a local wall-clock NaiveDateTime in `tz` to UTC using deterministic DST rules:
/// - Single: exact UTC instant
/// - Ambiguous (fall-back): earliest occurrence (`fold = 0`)
/// - None (spring-forward gap): advance forward by 1 hour to the first valid instant after the gap
pub fn resolve_local_to_utc(local: NaiveDateTime, tz: Tz) -> DateTime<Utc> {
    match tz.from_local_datetime(&local) {
        LocalResult::Single(dt) => dt.with_timezone(&Utc),
        LocalResult::Ambiguous(earliest, _latest) => earliest.with_timezone(&Utc),
        LocalResult::None => {
            // Advance minute-by-minute across the DST gap (at most 180 min) to first valid wall-clock time.
            for m in 1..=180 {
                let shifted = local + Duration::minutes(m);
                match tz.from_local_datetime(&shifted) {
                    LocalResult::Single(dt) => return dt.with_timezone(&Utc),
                    LocalResult::Ambiguous(earliest, _) => return earliest.with_timezone(&Utc),
                    LocalResult::None => continue,
                }
            }
            DateTime::<Utc>::from_naive_utc_and_offset(local, Utc)
        }
    }
}

/// Compute the UTC fire time for a single reminder against a task/occurrence schedule.
/// Returns `None` if a relative reminder has no due date (inactive).
pub fn compute_fire_time_utc(
    reminder: &Reminder,
    schedule: &Schedule,
    default_all_day_time: &str,
) -> Option<DateTime<Utc>> {
    let tz: Tz = schedule
        .timezone
        .parse()
        .unwrap_or(chrono_tz::Asia::Shanghai);

    match reminder {
        Reminder::Absolute { at, .. } => {
            let normalized = at.replace(' ', "T");
            let local = NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M")
                .or_else(|_| NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S"))
                .ok()?;
            Some(resolve_local_to_utc(local, tz))
        }
        Reminder::Relative {
            offset_minutes,
            offset_days,
            day_time,
            ..
        } => {
            let due = schedule.due.as_ref()?;
            let due_date = NaiveDate::parse_from_str(&due.date, "%Y-%m-%d").ok()?;

            if let Some(days) = offset_days {
                let target_date = due_date + Duration::days(*days);
                let t_str = day_time.as_deref().unwrap_or(default_all_day_time);
                let t = NaiveTime::parse_from_str(t_str, "%H:%M")
                    .unwrap_or_else(|_| NaiveTime::from_hms_opt(9, 0, 0).unwrap());
                return Some(resolve_local_to_utc(target_date.and_time(t), tz));
            }

            let base_time = if schedule.all_day || due.time.is_none() {
                NaiveTime::parse_from_str(default_all_day_time, "%H:%M")
                    .unwrap_or_else(|_| NaiveTime::from_hms_opt(9, 0, 0).unwrap())
            } else {
                NaiveTime::parse_from_str(due.time.as_deref().unwrap_or("09:00"), "%H:%M")
                    .unwrap_or_else(|_| NaiveTime::from_hms_opt(9, 0, 0).unwrap())
            };
            let base_utc = resolve_local_to_utc(due_date.and_time(base_time), tz);
            Some(base_utc + Duration::minutes(offset_minutes.unwrap_or(0)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DateTimePoint;

    #[test]
    fn shanghai_relative_reminders() {
        let sched = Schedule {
            all_day: false,
            due: Some(DateTimePoint {
                date: "2026-11-26".into(),
                time: Some("18:00".into()),
            }),
            timezone: "Asia/Shanghai".into(),
        };
        let r_1d = Reminder::Relative {
            id: "r1".into(),
            offset_minutes: Some(-1440),
            offset_days: None,
            day_time: None,
        };
        let r_1h = Reminder::Relative {
            id: "r2".into(),
            offset_minutes: Some(-60),
            offset_days: None,
            day_time: None,
        };
        assert_eq!(
            compute_fire_time_utc(&r_1d, &sched, "09:00")
                .unwrap()
                .to_rfc3339(),
            "2026-11-25T10:00:00+00:00"
        );
        assert_eq!(
            compute_fire_time_utc(&r_1h, &sched, "09:00")
                .unwrap()
                .to_rfc3339(),
            "2026-11-26T09:00:00+00:00"
        );
    }

    #[test]
    fn dst_spring_forward_and_fall_back() {
        // US/Eastern 2026-03-08 02:30 does not exist (spring forward 02:00 -> 03:00).
        let spring = NaiveDateTime::parse_from_str("2026-03-08T02:30", "%Y-%m-%dT%H:%M").unwrap();
        let utc_spring = resolve_local_to_utc(spring, chrono_tz::America::New_York);
        assert_eq!(utc_spring.to_rfc3339(), "2026-03-08T07:00:00+00:00"); // 03:00 EDT

        // US/Eastern 2026-11-01 01:30 occurs twice; fold=0 picks earliest (EDT, UTC-4).
        let fall = NaiveDateTime::parse_from_str("2026-11-01T01:30", "%Y-%m-%dT%H:%M").unwrap();
        let utc_fall = resolve_local_to_utc(fall, chrono_tz::America::New_York);
        assert_eq!(utc_fall.to_rfc3339(), "2026-11-01T05:30:00+00:00");
    }

    #[test]
    fn all_day_offset_days() {
        let sched = Schedule {
            all_day: true,
            due: Some(DateTimePoint {
                date: "2026-11-26".into(),
                time: None,
            }),
            timezone: "Asia/Shanghai".into(),
        };
        let r = Reminder::Relative {
            id: "r1".into(),
            offset_minutes: None,
            offset_days: Some(-1),
            day_time: Some("09:00".into()),
        };
        assert_eq!(
            compute_fire_time_utc(&r, &sched, "09:00")
                .unwrap()
                .to_rfc3339(),
            "2026-11-25T01:00:00+00:00"
        );
    }
}
