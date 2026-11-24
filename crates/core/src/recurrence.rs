use crate::error::{AppError, AppResult};
use crate::models::{
    CatchUpPolicy, DateTimePoint, InvalidDatePolicy, OccurrenceActionStatus, OccurrenceState,
    OccurrenceView, RepeatBasis, RepeatEnd, RepeatFreq, RepeatRule, Schedule, SeriesState,
};
use chrono::{Datelike, Duration, NaiveDate, Weekday};

pub fn parse_date(s: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|e| AppError::Validation(format!("无效日期 '{s}': {e}")))
}

pub fn format_date(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let next_first = NaiveDate::from_ymd_opt(ny, nm, 1).expect("valid next month");
    let this_first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month");
    (next_first - this_first).num_days() as u32
}

fn parse_weekday(code: &str) -> Option<Weekday> {
    match code.trim().to_uppercase().as_str() {
        "MO" | "MON" => Some(Weekday::Mon),
        "TU" | "TUE" => Some(Weekday::Tue),
        "WE" | "WED" => Some(Weekday::Wed),
        "TH" | "THU" => Some(Weekday::Thu),
        "FR" | "FRI" => Some(Weekday::Fri),
        "SA" | "SAT" => Some(Weekday::Sat),
        "SU" | "SUN" => Some(Weekday::Sun),
        _ => None,
    }
}

fn weekday_zh(wd: Weekday) -> &'static str {
    match wd {
        Weekday::Mon => "一",
        Weekday::Tue => "二",
        Weekday::Wed => "三",
        Weekday::Thu => "四",
        Weekday::Fri => "五",
        Weekday::Sat => "六",
        Weekday::Sun => "日",
    }
}

fn add_months_ym(year: i32, month: u32, add: i32) -> (i32, u32) {
    let total = (year * 12 + (month as i32 - 1)) + add;
    let y = total.div_euclid(12);
    let m = (total.rem_euclid(12) + 1) as u32;
    (y, m)
}

/// Generate up to `limit` occurrence keys (`YYYY-MM-DD`) strictly after `after` (if provided).
pub fn generate_occurrences(
    rule: &RepeatRule,
    limit: usize,
    after: Option<&str>,
) -> AppResult<Vec<String>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let dtstart = parse_date(&rule.dtstart)?;
    let after_date = match after {
        Some(s) => Some(parse_date(s)?),
        None => None,
    };
    let until_date = match &rule.end {
        RepeatEnd::Until { until } => Some(parse_date(until)?),
        _ => None,
    };
    let max_count = match &rule.end {
        RepeatEnd::Count { count } => Some(*count as usize),
        _ => None,
    };
    let interval = rule.interval.max(1) as i32;

    let mut out = Vec::new();
    let mut seq: usize = 0;

    let mut try_push = |d: NaiveDate| -> bool {
        if d < dtstart {
            return true;
        }
        if let Some(u) = until_date {
            if d > u {
                return false;
            }
        }
        seq += 1;
        if let Some(mc) = max_count {
            if seq > mc {
                return false;
            }
        }
        if after_date.map_or(true, |a| d > a) {
            out.push(format_date(d));
        }
        out.len() < limit
    };

    const MAX_STEPS: i32 = 20_000;
    for k in 0..MAX_STEPS {
        let mut candidates: Vec<NaiveDate> = Vec::new();

        match rule.freq {
            RepeatFreq::Daily => {
                let d = dtstart + Duration::days((k * interval) as i64);
                if rule.day_filter.as_deref() == Some("mon_fri")
                    && matches!(d.weekday(), Weekday::Sat | Weekday::Sun)
                {
                    continue;
                }
                candidates.push(d);
            }
            RepeatFreq::Weekly => {
                // Anchor to Monday of dtstart's week.
                let offset_from_mon = dtstart.weekday().num_days_from_monday() as i64;
                let week_mon =
                    dtstart - Duration::days(offset_from_mon) + Duration::days((k * 7 * interval) as i64);
                let mut wds: Vec<u32> = match &rule.by_weekday {
                    Some(list) if !list.is_empty() => list
                        .iter()
                        .filter_map(|w| parse_weekday(w))
                        .map(|w| w.num_days_from_monday())
                        .collect(),
                    _ => vec![dtstart.weekday().num_days_from_monday()],
                };
                wds.sort_unstable();
                wds.dedup();
                for wd_off in wds {
                    candidates.push(week_mon + Duration::days(wd_off as i64));
                }
            }
            RepeatFreq::Monthly => {
                let (y, m) = add_months_ym(dtstart.year(), dtstart.month(), k * interval);
                let dim = days_in_month(y, m);
                if let (Some(pos), Some(wds)) = (rule.by_set_pos, &rule.by_weekday) {
                    if let Some(target_wd) = wds.first().and_then(|w| parse_weekday(w)) {
                        let matching: Vec<u32> = (1..=dim)
                            .filter(|&day| {
                                NaiveDate::from_ymd_opt(y, m, day)
                                    .map(|d| d.weekday() == target_wd)
                                    .unwrap_or(false)
                            })
                            .collect();
                        let picked = if pos > 0 {
                            matching.get((pos - 1) as usize).copied()
                        } else if pos < 0 {
                            let idx = matching.len() as i32 + pos as i32;
                            if idx >= 0 {
                                matching.get(idx as usize).copied()
                            } else {
                                None
                            }
                        } else {
                            None
                        };
                        if let Some(day) = picked {
                            if let Some(d) = NaiveDate::from_ymd_opt(y, m, day) {
                                candidates.push(d);
                            }
                        }
                    }
                } else {
                    let target = rule
                        .by_month_day
                        .as_ref()
                        .and_then(|v| v.first().copied())
                        .unwrap_or(dtstart.day() as i8);
                    let day_opt = if target == -1 {
                        Some(dim)
                    } else if target > 0 {
                        let t = target as u32;
                        if t <= dim {
                            Some(t)
                        } else {
                            match rule.on_invalid_date {
                                InvalidDatePolicy::Clamp => Some(dim),
                                InvalidDatePolicy::Skip => None,
                            }
                        }
                    } else {
                        None
                    };
                    if let Some(day) = day_opt {
                        if let Some(d) = NaiveDate::from_ymd_opt(y, m, day) {
                            candidates.push(d);
                        }
                    }
                }
            }
            RepeatFreq::Yearly => {
                let y = dtstart.year() + k * interval;
                let m = rule
                    .by_month
                    .as_ref()
                    .and_then(|v| v.first().copied())
                    .map(|x| x as u32)
                    .unwrap_or(dtstart.month())
                    .clamp(1, 12);
                let dim = days_in_month(y, m);
                let target = rule
                    .by_month_day
                    .as_ref()
                    .and_then(|v| v.first().copied())
                    .unwrap_or(dtstart.day() as i8);
                let day_opt = if target == -1 {
                    Some(dim)
                } else if target > 0 {
                    let t = target as u32;
                    if t <= dim {
                        Some(t)
                    } else {
                        match rule.on_invalid_date {
                            InvalidDatePolicy::Clamp => Some(dim),
                            InvalidDatePolicy::Skip => None,
                        }
                    }
                } else {
                    None
                };
                if let Some(day) = day_opt {
                    if let Some(d) = NaiveDate::from_ymd_opt(y, m, day) {
                        candidates.push(d);
                    }
                }
            }
        }

        for d in candidates {
            if !try_push(d) {
                return Ok(out);
            }
        }
    }

    Ok(out)
}

/// Compute the next occurrence key after `completed_on` for a rule (supports both Schedule and Completion basis).
pub fn next_after_action(
    rule: &RepeatRule,
    acted_key: &str,
    completed_on_date: NaiveDate,
) -> AppResult<Option<String>> {
    match rule.basis {
        RepeatBasis::Schedule => {
            let nexts = generate_occurrences(rule, 1, Some(acted_key))?;
            Ok(nexts.into_iter().next())
        }
        RepeatBasis::Completion => {
            let iv = rule.interval.max(1) as i32;
            let next_date = match rule.freq {
                RepeatFreq::Daily => completed_on_date + Duration::days(iv as i64),
                RepeatFreq::Weekly => completed_on_date + Duration::days((iv * 7) as i64),
                RepeatFreq::Monthly => {
                    let (y, m) = add_months_ym(completed_on_date.year(), completed_on_date.month(), iv);
                    let d = completed_on_date.day().min(days_in_month(y, m));
                    NaiveDate::from_ymd_opt(y, m, d).expect("valid clamped date")
                }
                RepeatFreq::Yearly => {
                    let y = completed_on_date.year() + iv;
                    let m = completed_on_date.month();
                    let d = completed_on_date.day().min(days_in_month(y, m));
                    NaiveDate::from_ymd_opt(y, m, d).expect("valid clamped date")
                }
            };
            if let RepeatEnd::Until { until } = &rule.end {
                if next_date > parse_date(until)? {
                    return Ok(None);
                }
            }
            Ok(Some(format_date(next_date)))
        }
    }
}

/// Compute the effective current occurrence key given `today` (YYYY-MM-DD).
/// With `CatchUpPolicy::Latest`, overdue past occurrences automatically become `Missed` without writing to NAS.
pub fn effective_current_key(
    rule: &RepeatRule,
    series: &SeriesState,
    today: &str,
) -> AppResult<Option<String>> {
    if series.ended_at.is_some() {
        return Ok(None);
    }
    let mut cur = series.cursor.clone();
    if rule.catch_up == CatchUpPolicy::Latest && cur.as_str() < today {
        let mut seq = vec![cur.clone()];
        let more = generate_occurrences(rule, 500, Some(&cur))?;
        seq.extend(more);
        if let Some(latest) = seq.into_iter().filter(|k| k.as_str() <= today).last() {
            cur = latest;
        }
    }
    Ok(Some(cur))
}

/// Compute missed occurrence keys (between stored cursor and effective current key).
pub fn missed_keys(
    rule: &RepeatRule,
    series: &SeriesState,
    today: &str,
) -> AppResult<Vec<String>> {
    let Some(cur) = effective_current_key(rule, series, today)? else {
        return Ok(Vec::new());
    };
    if cur == series.cursor {
        return Ok(Vec::new());
    }
    let mut all = vec![series.cursor.clone()];
    all.extend(generate_occurrences(rule, 500, Some(&series.cursor))?);
    Ok(all.into_iter().filter(|k| k < &cur).collect())
}

/// Shift the template schedule to a specific occurrence key, applying any per-occurrence override.
pub fn schedule_for_occurrence(
    template: &Schedule,
    series: &SeriesState,
    key: &str,
) -> Schedule {
    if let Some(ov) = series.overrides.get(key) {
        if let Some(sched) = &ov.schedule {
            return sched.clone();
        }
    }
    Schedule {
        all_day: template.all_day,
        due: Some(DateTimePoint {
            date: key.to_string(),
            time: if template.all_day {
                None
            } else {
                template.due.as_ref().and_then(|d| d.time.clone())
            },
        }),
        timezone: template.timezone.clone(),
    }
}

/// Build the occurrence timeline for UI display (recent history + missed + current + next N future).
pub fn build_occurrence_timeline(
    rule: &RepeatRule,
    series: &SeriesState,
    template: &Schedule,
    today: &str,
    future_count: usize,
) -> AppResult<Vec<OccurrenceView>> {
    let mut items = Vec::new();
    for h in series.history.iter().take(10).rev() {
        items.push(OccurrenceView {
            key: h.key.clone(),
            state: match h.status {
                OccurrenceActionStatus::Completed => OccurrenceState::Completed,
                OccurrenceActionStatus::Skipped => OccurrenceState::Skipped,
            },
            schedule: schedule_for_occurrence(template, series, &h.key),
            acted_at: Some(h.at.clone()),
        });
    }
    for mk in missed_keys(rule, series, today)? {
        items.push(OccurrenceView {
            key: mk.clone(),
            state: OccurrenceState::Missed,
            schedule: schedule_for_occurrence(template, series, &mk),
            acted_at: None,
        });
    }
    if let Some(cur) = effective_current_key(rule, series, today)? {
        items.push(OccurrenceView {
            key: cur.clone(),
            state: OccurrenceState::Pending,
            schedule: schedule_for_occurrence(template, series, &cur),
            acted_at: None,
        });
        for fk in generate_occurrences(rule, future_count, Some(&cur))? {
            items.push(OccurrenceView {
                key: fk.clone(),
                state: OccurrenceState::Future,
                schedule: schedule_for_occurrence(template, series, &fk),
                acted_at: None,
            });
        }
    }
    Ok(items)
}

/// Human-readable Chinese description of a RepeatRule (used in UI and note summary).
pub fn describe_rule_zh(rule: &RepeatRule) -> String {
    let n = rule.interval.max(1);
    let mut s = match rule.freq {
        RepeatFreq::Daily => {
            if rule.day_filter.as_deref() == Some("mon_fri") {
                "工作日（周一至周五）".to_string()
            } else if n == 1 {
                "每天".to_string()
            } else {
                format!("每 {n} 天")
            }
        }
        RepeatFreq::Weekly => {
            let prefix = if n == 1 {
                "每周".to_string()
            } else {
                format!("每 {n} 周")
            };
            if let Some(wds) = &rule.by_weekday {
                let labels: Vec<String> = wds
                    .iter()
                    .filter_map(|w| parse_weekday(w))
                    .map(|w| format!("周{}", weekday_zh(w)))
                    .collect();
                if !labels.is_empty() {
                    format!("{prefix} {}", labels.join("、"))
                } else {
                    prefix
                }
            } else {
                prefix
            }
        }
        RepeatFreq::Monthly => {
            let prefix = if n == 1 {
                "每月".to_string()
            } else {
                format!("每 {n} 个月")
            };
            if let (Some(pos), Some(wds)) = (rule.by_set_pos, &rule.by_weekday) {
                let wd = wds
                    .first()
                    .and_then(|w| parse_weekday(w))
                    .map(weekday_zh)
                    .unwrap_or("一");
                let pos_s = if pos == -1 {
                    "最后一".to_string()
                } else {
                    pos.to_string()
                };
                format!("{prefix} 第{pos_s}个周{wd}")
            } else {
                let day = rule
                    .by_month_day
                    .as_ref()
                    .and_then(|v| v.first().copied())
                    .unwrap_or_else(|| parse_date(&rule.dtstart).map(|d| d.day() as i8).unwrap_or(1));
                if day == -1 {
                    format!("{prefix} 最后一天")
                } else {
                    format!("{prefix} {day} 日")
                }
            }
        }
        RepeatFreq::Yearly => {
            let prefix = if n == 1 {
                "每年".to_string()
            } else {
                format!("每 {n} 年")
            };
            let dt = parse_date(&rule.dtstart).ok();
            let m = rule
                .by_month
                .as_ref()
                .and_then(|v| v.first().copied())
                .map(|x| x as u32)
                .or_else(|| dt.map(|d| d.month()))
                .unwrap_or(1);
            let day = rule
                .by_month_day
                .as_ref()
                .and_then(|v| v.first().copied())
                .map(|x| x as u32)
                .or_else(|| dt.map(|d| d.day()))
                .unwrap_or(1);
            format!("{prefix} {m}月{day}日")
        }
    };

    match &rule.end {
        RepeatEnd::Never => {}
        RepeatEnd::Until { until } => s.push_str(&format!("，至 {until}")),
        RepeatEnd::Count { count } => s.push_str(&format!("，共 {count} 次")),
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn base_rule(freq: RepeatFreq, dtstart: &str) -> RepeatRule {
        RepeatRule {
            freq,
            interval: 1,
            calendar: Default::default(),
            by_weekday: None,
            by_set_pos: None,
            by_month_day: None,
            by_month: None,
            lunar: None,
            day_filter: None,
            on_invalid_date: InvalidDatePolicy::Clamp,
            basis: RepeatBasis::Schedule,
            catch_up: CatchUpPolicy::Latest,
            end: RepeatEnd::Never,
            dtstart: dtstart.to_string(),
        }
    }

    #[test]
    fn semi_annual_esim() {
        let mut r = base_rule(RepeatFreq::Monthly, "2026-11-24");
        r.interval = 6;
        r.by_month_day = Some(vec![24]);
        let occ = generate_occurrences(&r, 4, None).unwrap();
        assert_eq!(occ, vec!["2026-11-24", "2027-05-24", "2027-11-24", "2028-05-24"]);
    }

    #[test]
    fn monthly_31st_clamp_vs_skip() {
        let mut r = base_rule(RepeatFreq::Monthly, "2026-01-31");
        r.by_month_day = Some(vec![31]);
        r.on_invalid_date = InvalidDatePolicy::Clamp;
        let clamped = generate_occurrences(&r, 4, None).unwrap();
        assert_eq!(clamped, vec!["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);

        r.on_invalid_date = InvalidDatePolicy::Skip;
        let skipped = generate_occurrences(&r, 4, None).unwrap();
        assert_eq!(skipped, vec!["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
    }

    #[test]
    fn monthly_last_day_and_nth_monday() {
        let mut last = base_rule(RepeatFreq::Monthly, "2024-01-31");
        last.by_month_day = Some(vec![-1]);
        assert_eq!(
            generate_occurrences(&last, 3, None).unwrap(),
            vec!["2024-01-31", "2024-02-29", "2024-03-31"]
        );

        let mut nth = base_rule(RepeatFreq::Monthly, "2026-11-01");
        nth.by_weekday = Some(vec!["MO".into()]);
        nth.by_set_pos = Some(1);
        assert_eq!(
            generate_occurrences(&nth, 3, None).unwrap(),
            vec!["2026-11-02", "2026-12-07", "2027-01-04"]
        );
    }

    #[test]
    fn yearly_feb_29_leap_year_clamp_and_skip() {
        let mut r = base_rule(RepeatFreq::Yearly, "2024-02-29");
        r.by_month = Some(vec![2]);
        r.by_month_day = Some(vec![29]);
        assert_eq!(
            generate_occurrences(&r, 5, None).unwrap(),
            vec!["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]
        );
        r.on_invalid_date = InvalidDatePolicy::Skip;
        assert_eq!(
            generate_occurrences(&r, 2, None).unwrap(),
            vec!["2024-02-29", "2028-02-29"]
        );
    }

    #[test]
    fn workdays_and_weekly_multi_days_and_count() {
        let mut wd = base_rule(RepeatFreq::Daily, "2026-11-20"); // Friday
        wd.day_filter = Some("mon_fri".into());
        assert_eq!(
            generate_occurrences(&wd, 3, None).unwrap(),
            vec!["2026-11-20", "2026-11-23", "2026-11-24"]
        );

        let mut wk = base_rule(RepeatFreq::Weekly, "2026-11-23"); // Monday
        wk.by_weekday = Some(vec!["MO".into(), "WE".into(), "FR".into()]);
        wk.end = RepeatEnd::Count { count: 4 };
        assert_eq!(
            generate_occurrences(&wk, 10, None).unwrap(),
            vec!["2026-11-23", "2026-11-25", "2026-11-27", "2026-11-30"]
        );
    }

    #[test]
    fn catch_up_latest_vs_each() {
        let mut r = base_rule(RepeatFreq::Daily, "2026-11-20");
        let s = SeriesState {
            cursor: "2026-11-20".into(),
            overrides: BTreeMap::new(),
            history: vec![],
            history_summary: None,
            ended_at: None,
        };
        assert_eq!(effective_current_key(&r, &s, "2026-11-23").unwrap().as_deref(), Some("2026-11-23"));
        assert_eq!(missed_keys(&r, &s, "2026-11-23").unwrap(), vec!["2026-11-20", "2026-11-21", "2026-11-22"]);

        r.catch_up = CatchUpPolicy::Each;
        assert_eq!(effective_current_key(&r, &s, "2026-11-23").unwrap().as_deref(), Some("2026-11-20"));
        assert!(missed_keys(&r, &s, "2026-11-23").unwrap().is_empty());
    }
}
