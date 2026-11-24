use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Task priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    #[default]
    Normal,
    High,
    Urgent,
}

impl Priority {
    pub fn label_zh(&self) -> &'static str {
        match self {
            Priority::Low => "低",
            Priority::Normal => "普通",
            Priority::High => "高",
            Priority::Urgent => "紧急",
        }
    }

    pub fn parse_flexible(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "low" | "低" => Some(Priority::Low),
            "normal" | "medium" | "普通" | "中" => Some(Priority::Normal),
            "high" | "高" => Some(Priority::High),
            "urgent" | "紧急" => Some(Priority::Urgent),
            _ => None,
        }
    }

    /// Sort rank where Urgent = 0 (highest) and Low = 3 (lowest).
    pub fn sort_rank(&self) -> u8 {
        match self {
            Priority::Urgent => 0,
            Priority::High => 1,
            Priority::Normal => 2,
            Priority::Low => 3,
        }
    }
}

/// Status of a task (single task: Pending/Completed; series: Active/Ended).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    #[default]
    Pending,
    Completed,
    Active,
    Ended,
}

impl TaskStatus {
    pub fn label_zh(&self) -> &'static str {
        match self {
            TaskStatus::Pending | TaskStatus::Active => "待办",
            TaskStatus::Completed => "已完成",
            TaskStatus::Ended => "已结束",
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(self, TaskStatus::Completed | TaskStatus::Ended)
    }
}

/// Date + optional local wall-clock time (`YYYY-MM-DD`, optional `HH:MM`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateTimePoint {
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
}

/// Simplified schedule (D8): due date + due time + all_day + IANA timezone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schedule {
    #[serde(default)]
    pub all_day: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<DateTimePoint>,
    #[serde(default = "default_timezone")]
    pub timezone: String,
}

fn default_timezone() -> String {
    "Asia/Shanghai".to_string()
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            all_day: false,
            due: None,
            timezone: default_timezone(),
        }
    }
}

/// Independent reminder rule attached to a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Reminder {
    Relative {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset_minutes: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset_days: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        day_time: Option<String>,
    },
    Absolute {
        id: String,
        /// Local wall-clock `YYYY-MM-DDTHH:MM`.
        at: String,
    },
}

impl Reminder {
    pub fn id(&self) -> &str {
        match self {
            Reminder::Relative { id, .. } | Reminder::Absolute { id, .. } => id,
        }
    }

    pub fn label_zh(&self) -> String {
        match self {
            Reminder::Absolute { at, .. } => format!("于 {}", at.replace('T', " ")),
            Reminder::Relative {
                offset_minutes,
                offset_days,
                day_time,
                ..
            } => {
                if let Some(days) = offset_days {
                    let t = day_time.as_deref().unwrap_or("09:00");
                    if *days == 0 {
                        return format!("当天 {t}");
                    }
                    return format!("提前 {} 天 {t}", days.abs());
                }
                let mins = offset_minutes.unwrap_or(0);
                if mins == 0 {
                    return "到期时".to_string();
                }
                let abs = mins.abs();
                if abs % 1440 == 0 {
                    format!("提前 {} 天", abs / 1440)
                } else if abs % 60 == 0 {
                    format!("提前 {} 小时", abs / 60)
                } else {
                    format!("提前 {} 分钟", abs)
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepeatFreq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CalendarKind {
    #[default]
    Gregorian,
    Lunar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum InvalidDatePolicy {
    #[default]
    Clamp,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RepeatBasis {
    #[default]
    Schedule,
    Completion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CatchUpPolicy {
    #[default]
    Latest,
    Each,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RepeatEnd {
    #[default]
    Never,
    Until {
        until: String,
    },
    Count {
        count: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LunarSpec {
    pub month: u8,
    pub day: u8,
    #[serde(default = "default_lunar_leap")]
    pub leap: String,
}

fn default_lunar_leap() -> String {
    "follow".to_string()
}

/// Recurrence rule stored on a repeating series task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepeatRule {
    pub freq: RepeatFreq,
    #[serde(default = "default_interval")]
    pub interval: u32,
    #[serde(default)]
    pub calendar: CalendarKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_weekday: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_set_pos: Option<i8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_month_day: Option<Vec<i8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_month: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lunar: Option<LunarSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_filter: Option<String>,
    #[serde(default)]
    pub on_invalid_date: InvalidDatePolicy,
    #[serde(default)]
    pub basis: RepeatBasis,
    #[serde(default)]
    pub catch_up: CatchUpPolicy,
    #[serde(default)]
    pub end: RepeatEnd,
    /// Anchor date (`YYYY-MM-DD`) of the first occurrence.
    pub dtstart: String,
}

fn default_interval() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OccurrenceActionStatus {
    Completed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccurrenceHistoryEntry {
    pub key: String,
    pub status: OccurrenceActionStatus,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct HistorySummary {
    #[serde(default)]
    pub completed: u32,
    #[serde(default)]
    pub skipped: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct OccurrenceOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Schedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeriesState {
    pub cursor: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub overrides: BTreeMap<String, OccurrenceOverride>,
    #[serde(default)]
    pub history: Vec<OccurrenceHistoryEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_summary: Option<HistorySummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MetaState {
    #[default]
    Ok,
    Missing,
    Recovered,
    Conflict,
}

/// Full Task DTO shared across core, Tauri commands, and frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// True if the original note body contains unsupported rich HTML (tables/images/colors)
    /// that must be preserved verbatim on write.
    #[serde(default)]
    pub rich_body_protected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_description_html: Option<String>,
    #[serde(default)]
    pub status: TaskStatus,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub schedule: Schedule,
    #[serde(default)]
    pub reminders: Vec<Reminder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<RepeatRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<SeriesState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub meta_state: MetaState,
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    pub etag: String,
}

fn default_source() -> String {
    "zspace_notebook".to_string()
}

/// Computed occurrence view item for a repeating series timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OccurrenceState {
    Completed,
    Skipped,
    Missed,
    Pending,
    Future,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccurrenceView {
    pub key: String,
    pub state: OccurrenceState,
    pub schedule: Schedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acted_at: Option<String>,
}

/// Flattened calendar cell item (either a single task or one expanded occurrence of a repeating series).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalendarTaskItem {
    pub task_id: i64,
    pub title: String,
    /// Actual displayed date (`YYYY-MM-DD`, after applying any per-occurrence override).
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    pub all_day: bool,
    pub priority: Priority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<String>,
    pub done: bool,
    pub is_repeating: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence_key: Option<String>,
}

/// Task view categories (DESIGN §7.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskView {
    Inbox,
    Today,
    Upcoming,
    Overdue,
    All,
    Completed,
    Repeating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskSort {
    #[default]
    Date,
    Priority,
    Created,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub list: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub schedule: Schedule,
    #[serde(default)]
    pub reminders: Vec<Reminder>,
    #[serde(default)]
    pub repeat: Option<RepeatRule>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateTaskInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<Priority>,
    pub list: Option<Option<String>>,
    pub labels: Option<Vec<String>>,
    pub pinned: Option<bool>,
    pub schedule: Option<Schedule>,
    pub reminders: Option<Vec<Reminder>>,
    pub repeat: Option<Option<RepeatRule>>,
    pub etag: Option<String>,
    #[serde(default)]
    pub force: bool,
}
