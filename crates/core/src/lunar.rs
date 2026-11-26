use crate::lunar_tables::{CN_HOLIDAY_OVERRIDES, LUNAR_MAX_YEAR, LUNAR_MIN_YEAR, LUNAR_YEARS};
use chrono::{Datelike, Duration, NaiveDate, Weekday};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LunarDate {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub is_leap: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LunarMonthMeta {
    pub year: i32,
    pub month: u8,
    pub is_leap: bool,
    pub days: u8,
}

fn epoch_1900() -> NaiveDate {
    NaiveDate::from_ymd_opt(1900, 1, 1).expect("valid 1900-01-01")
}

pub fn year_leap_month(lunar_year: i32) -> Option<u8> {
    if !(LUNAR_MIN_YEAR..=LUNAR_MAX_YEAR).contains(&lunar_year) {
        return None;
    }
    let (_, leap, _) = LUNAR_YEARS[(lunar_year - LUNAR_MIN_YEAR) as usize];
    if leap > 0 {
        Some(leap)
    } else {
        None
    }
}

/// Ordered months inside a Chinese lunar year (`1..=12`, plus optional `leap` right after its base month).
pub fn year_month_sequence(lunar_year: i32) -> Option<(i32, Vec<LunarMonthMeta>)> {
    if !(LUNAR_MIN_YEAR..=LUNAR_MAX_YEAR).contains(&lunar_year) {
        return None;
    }
    let (cny_days, leap, mask) = LUNAR_YEARS[(lunar_year - LUNAR_MIN_YEAR) as usize];
    let mut seq = Vec::with_capacity(if leap > 0 { 13 } else { 12 });
    let mut bit = 0usize;
    for m in 1..=12u8 {
        let days = if (mask & (1 << bit)) != 0 { 30 } else { 29 };
        seq.push(LunarMonthMeta {
            year: lunar_year,
            month: m,
            is_leap: false,
            days,
        });
        bit += 1;
        if leap == m {
            let l_days = if (mask & (1 << bit)) != 0 { 30 } else { 29 };
            seq.push(LunarMonthMeta {
                year: lunar_year,
                month: m,
                is_leap: true,
                days: l_days,
            });
            bit += 1;
        }
    }
    Some((cny_days, seq))
}

pub fn lunar_month_days(lunar_year: i32, month: u8, is_leap: bool) -> Option<u8> {
    let (_, seq) = year_month_sequence(lunar_year)?;
    seq.into_iter()
        .find(|m| m.month == month && m.is_leap == is_leap)
        .map(|m| m.days)
}

pub fn lunar_to_solar(lunar: LunarDate) -> Option<NaiveDate> {
    let (cny_days, seq) = year_month_sequence(lunar.year)?;
    let mut offset = 0i64;
    for m in seq {
        if m.month == lunar.month && m.is_leap == lunar.is_leap {
            if lunar.day == 0 || lunar.day > m.days {
                return None;
            }
            return epoch_1900().checked_add_signed(Duration::days(
                cny_days as i64 + offset + (lunar.day - 1) as i64,
            ));
        }
        offset += m.days as i64;
    }
    None
}

pub fn solar_to_lunar(date: NaiveDate) -> Option<LunarDate> {
    let days = (date - epoch_1900()).num_days();
    let idx = LUNAR_YEARS.partition_point(|row| (row.0 as i64) <= days);
    if idx == 0 {
        return None;
    }
    let year = LUNAR_MIN_YEAR + (idx - 1) as i32;
    let (cny_days, seq) = year_month_sequence(year)?;
    let mut rem = days - cny_days as i64;
    if rem < 0 {
        return None;
    }
    for m in seq {
        if rem < m.days as i64 {
            return Some(LunarDate {
                year,
                month: m.month,
                day: (rem + 1) as u8,
                is_leap: m.is_leap,
            });
        }
        rem -= m.days as i64;
    }
    None
}

/// Official Chinese workday check:
/// - Consults State Council holiday/adjusted-workday schedule (2001..=2027) first
///   (`false` for statutory holidays even on Mon–Fri, `true` for 调休补班 weekends).
/// - Falls back to standard Mon–Fri for dates outside published holiday tables.
pub fn is_cn_workday(date: NaiveDate) -> bool {
    let ymd = (date.year().max(0) as u32) * 10_000 + date.month() * 100 + date.day();
    if let Ok(pos) = CN_HOLIDAY_OVERRIDES.binary_search_by_key(&ymd, |entry| entry >> 1) {
        return (CN_HOLIDAY_OVERRIDES[pos] & 1) == 1;
    }
    !matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

pub fn lunar_month_zh(month: u8, is_leap: bool) -> String {
    const NAMES: [&str; 12] = [
        "正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月",
        "腊月",
    ];
    let base = NAMES
        .get(month.saturating_sub(1) as usize)
        .copied()
        .unwrap_or("正月");
    if is_leap {
        format!("闰{base}")
    } else {
        base.to_string()
    }
}

pub fn lunar_day_zh(day: u8) -> String {
    match day {
        1..=10 => {
            const ONES: [&str; 10] = [
                "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
            ];
            ONES[(day - 1) as usize].to_string()
        }
        11..=19 => {
            const TEENS: [&str; 9] = [
                "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九",
            ];
            TEENS[(day - 11) as usize].to_string()
        }
        20 => "二十".to_string(),
        21..=29 => {
            const TWENTIES: [&str; 9] = [
                "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九",
            ];
            TWENTIES[(day - 21) as usize].to_string()
        }
        30 => "三十".to_string(),
        _ => format!("{day}日"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhaustive_solar_lunar_roundtrip_1901_to_2099() {
        let start = NaiveDate::from_ymd_opt(1901, 2, 19).unwrap();
        let end = NaiveDate::from_ymd_opt(2099, 12, 31).unwrap();
        let mut d = start;
        while d <= end {
            let lun = solar_to_lunar(d).expect("inside supported range");
            let back = lunar_to_solar(lun).expect("roundtrip back to solar");
            assert_eq!(back, d, "mismatch on {d:?} via {lun:?}");
            d = d.succ_opt().unwrap();
        }
    }

    #[test]
    fn known_lunar_dates_and_leap_months_match() {
        // 2025 had leap June (闰六月): 2025-07-25 is 农历 2025年闰六月初一
        let d = NaiveDate::from_ymd_opt(2025, 7, 25).unwrap();
        assert_eq!(
            solar_to_lunar(d),
            Some(LunarDate {
                year: 2025,
                month: 6,
                day: 1,
                is_leap: true,
            })
        );
        // 2026 Chinese New Year = 2026-02-17
        assert_eq!(
            lunar_to_solar(LunarDate {
                year: 2026,
                month: 1,
                day: 1,
                is_leap: false,
            }),
            NaiveDate::from_ymd_opt(2026, 2, 17)
        );
        // 2026 Mid-Autumn Festival = 2026-09-25 (农历八月十五)
        assert_eq!(
            solar_to_lunar(NaiveDate::from_ymd_opt(2026, 9, 25).unwrap()),
            Some(LunarDate {
                year: 2026,
                month: 8,
                day: 15,
                is_leap: false,
            })
        );
    }

    #[test]
    fn cn_workday_handles_statutory_holidays_and_weekend_makeups() {
        // 2026-01-01 (Thu): New Year Holiday -> false
        assert!(!is_cn_workday(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()));
        // 2026-01-04 (Sun): Adjusted makeup workday -> true
        assert!(is_cn_workday(NaiveDate::from_ymd_opt(2026, 1, 4).unwrap()));
        // 2026-10-01..10-07 National Day Holiday -> false
        assert!(!is_cn_workday(
            NaiveDate::from_ymd_opt(2026, 10, 5).unwrap()
        ));
        // 2026-10-10 (Sat): Adjusted makeup workday -> true
        assert!(is_cn_workday(
            NaiveDate::from_ymd_opt(2026, 10, 10).unwrap()
        ));
        // 2026-11-28 (Sat): Normal weekend -> false
        assert!(!is_cn_workday(
            NaiveDate::from_ymd_opt(2026, 11, 28).unwrap()
        ));
        // 2026-11-26 (Thu): Normal weekday -> true
        assert!(is_cn_workday(
            NaiveDate::from_ymd_opt(2026, 11, 26).unwrap()
        ));
    }
}
