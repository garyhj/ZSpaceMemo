use crate::models::{
    DateTimePoint, MetaState, OccurrenceActionStatus, Priority, Reminder, RepeatRule, Schedule,
    SeriesState, Task, TaskAttachment, TaskStatus,
};
use crate::recurrence::describe_rule_zh;
use base64::Engine;
use chrono::{Datelike, NaiveDate, Weekday};
use html_escape::{decode_html_entities, encode_text};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// Compact JSON structure embedded in `<p>ZSM1:{...}</p>` at the end of a ZSpace note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMetaV1 {
    #[serde(default = "default_version")]
    pub v: u32,
    #[serde(default = "default_rev")]
    pub rev: u64,
    #[serde(default)]
    pub status: TaskStatus,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(default)]
    pub schedule: Schedule,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reminders: Vec<Reminder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<RepeatRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<SeriesState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<TaskAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sum: Option<String>,
    /// Forward-compatibility bucket: preserves any unknown fields from future versions.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

fn default_version() -> u32 {
    1
}

fn default_rev() -> u64 {
    1
}

pub struct EncodedNote {
    pub title: String,
    pub body: String,
    pub in_brief: String,
    pub etag: String,
}

#[derive(Debug, Clone)]
pub struct DecodedNote {
    pub task: Task,
    pub meta_present: bool,
    pub meta_corrupted: bool,
    pub summary_externally_edited: bool,
}

fn strip_tags_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap())
}

fn h1_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)^\s*<h1\b[^>]*>.*?</h1>\s*").unwrap())
}

fn hr_split_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<hr\s*/?>").unwrap())
}

fn rich_html_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<(img|table|iframe|video|audio)\b|style\s*=").unwrap())
}

fn md_link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[([^\]]+)\]\((https?://[^)\s]+)\)").unwrap())
}

fn md_bold_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\*\*([^*]+)\*\*").unwrap())
}

fn html_link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?is)<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap())
}

fn html_strong_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<(?:strong|b)\b[^>]*>(.*?)</(?:strong|b)>").unwrap())
}

fn p_block_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<p\b[^>]*>(.*?)</p>").unwrap())
}

/// Short 8-char SHA-256 hex hash of normalized plain text (HTML entities unescaped).
pub fn short_hash(text: &str) -> String {
    let normalized = decode_html_entities(text).trim().to_string();
    let mut h = Sha256::new();
    h.update(normalized.as_bytes());
    format!("{:x}", h.finalize())[..8].to_string()
}

pub fn compute_etag(rev: u64, body: &str) -> String {
    format!("W/\"{}-{}\"", rev, short_hash(body))
}

fn weekday_zh(date_str: &str) -> &'static str {
    NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
        .map(|d| match d.weekday() {
            Weekday::Mon => "周一",
            Weekday::Tue => "周二",
            Weekday::Wed => "周三",
            Weekday::Thu => "周四",
            Weekday::Fri => "周五",
            Weekday::Sat => "周六",
            Weekday::Sun => "周日",
        })
        .unwrap_or("")
}

fn format_due_summary(schedule: &Schedule) -> Option<String> {
    let due = schedule.due.as_ref()?;
    let wd = weekday_zh(&due.date);
    let mut s = format!("📅 截止 {} {}", due.date, wd);
    if !schedule.all_day {
        if let Some(t) = &due.time {
            s.push(' ');
            s.push_str(t);
        }
    } else {
        s.push_str("（全天）");
    }
    Some(s.trim().to_string())
}

/// Build the human-readable Chinese summary lines shown at the top of the native ZSpace note.
pub fn render_summary_lines(task: &Task) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(due_line) = format_due_summary(&task.schedule) {
        lines.push(due_line);
    }
    let mut meta_parts = Vec::new();
    if let Some(r) = &task.repeat {
        meta_parts.push(format!("🔁 {}", describe_rule_zh(r)));
    }
    if !task.reminders.is_empty() {
        let rlabels: Vec<String> = task.reminders.iter().map(|r| r.label_zh()).collect();
        meta_parts.push(format!("⏰ {}", rlabels.join("、")));
    }
    meta_parts.push(format!("优先级：{}", task.priority.label_zh()));
    if let Some(list) = &task.list {
        if !list.trim().is_empty() {
            meta_parts.push(format!("清单：{}", list.trim()));
        }
    }
    if !task.attachments.is_empty() {
        let preview: Vec<&str> = task
            .attachments
            .iter()
            .take(3)
            .map(|a| a.name.as_str())
            .collect();
        let suffix = if task.attachments.len() > 3 { "…" } else { "" };
        meta_parts.push(format!(
            "📎 附件 {} 个（{}{}）",
            task.attachments.len(),
            preview.join("、"),
            suffix
        ));
    }
    lines.push(meta_parts.join(" · "));

    let mut st = format!("状态：{}", task.status.label_zh());
    if let Some(series) = &task.series {
        if series.ended_at.is_none() {
            st.push_str(&format!(" · 本次 {}", series.cursor));
        }
        if let Some(last) = series
            .history
            .iter()
            .find(|h| h.status == OccurrenceActionStatus::Completed)
        {
            st.push_str(&format!(" · 上次完成 {}", last.key));
        }
    }
    lines.push(st);
    lines
}

/// Convert simple Markdown subset (multi-line, links, bold, bullets) to clean HTML paragraphs.
pub fn markdown_to_html(md: &str) -> String {
    let mut out = Vec::new();
    for raw_line in md.lines() {
        let line = raw_line.trim_end();
        if line.is_empty() {
            continue;
        }
        let (is_bullet, content) = if let Some(rest) = line.strip_prefix("- ") {
            (true, rest)
        } else {
            (false, line)
        };
        let escaped = encode_text(content).into_owned();
        let with_links = md_link_re()
            .replace_all(&escaped, r#"<a href="$2">$1</a>"#)
            .into_owned();
        let with_bold = md_bold_re()
            .replace_all(&with_links, r#"<strong>$1</strong>"#)
            .into_owned();
        if is_bullet {
            out.push(format!("<p>• {with_bold}</p>"));
        } else {
            out.push(format!("<p>{with_bold}</p>"));
        }
    }
    out.join("")
}

/// Convert simple HTML description paragraphs back into our Markdown subset.
pub fn html_to_markdown(html_fragment: &str) -> String {
    let mut lines = Vec::new();
    let captures: Vec<String> = p_block_re()
        .captures_iter(html_fragment)
        .map(|c| c[1].to_string())
        .collect();

    let blocks = if captures.is_empty() {
        let plain = html_fragment.trim();
        if plain.is_empty() {
            Vec::new()
        } else {
            vec![plain.to_string()]
        }
    } else {
        captures
    };

    for block in blocks {
        let with_links = html_link_re().replace_all(&block, "[$2]($1)").into_owned();
        let with_bold = html_strong_re().replace_all(&with_links, "**$1**").into_owned();
        let plain = strip_tags_re().replace_all(&with_bold, "").into_owned();
        let unescaped = decode_html_entities(&plain).trim().to_string();
        if unescaped.is_empty() {
            continue;
        }
        if let Some(rest) = unescaped.strip_prefix("• ") {
            lines.push(format!("- {rest}"));
        } else {
            lines.push(unescaped);
        }
    }
    lines.join("\n")
}

/// Encode a `Task` into a ZSpace native note (`<p>ZSM1:{...}</p>` format verified in M0).
pub fn encode_task_note(task: &Task) -> EncodedNote {
    let summary_lines = render_summary_lines(task);
    let summary_plain = summary_lines.join("\n");
    let sum = short_hash(&summary_plain);

    let meta = NoteMetaV1 {
        v: 1,
        rev: task.rev.max(1),
        status: task.status,
        priority: task.priority,
        list: task.list.clone(),
        labels: task.labels.clone(),
        schedule: task.schedule.clone(),
        reminders: task.reminders.clone(),
        repeat: task.repeat.clone(),
        series: task.series.clone(),
        attachments: task.attachments.clone(),
        completed_at: task.completed_at.clone(),
        created_at: task.created_at.clone(),
        sum: Some(sum),
        extra: BTreeMap::new(),
    };
    let meta_json = serde_json::to_string(&meta).expect("NoteMetaV1 serializes cleanly");

    let mut html = String::new();
    html.push_str(&format!("<h1>{}</h1>", encode_text(&task.title)));
    for line in &summary_lines {
        html.push_str(&format!("<p>{}</p>", encode_text(line)));
    }
    html.push_str("<hr>");
    if task.rich_body_protected {
        if let Some(raw) = &task.raw_description_html {
            html.push_str(raw);
        }
    } else if !task.description.trim().is_empty() {
        html.push_str(&markdown_to_html(&task.description));
    }
    html.push_str("<hr>");
    html.push_str("<p>⚙ ZSpace Memo 数据（请勿手动修改）</p>");
    html.push_str(&format!("<p>ZSM1:{meta_json}</p>"));

    let in_brief = summary_lines
        .first()
        .cloned()
        .unwrap_or_else(|| task.title.clone())
        .chars()
        .take(100)
        .collect();
    let etag = compute_etag(meta.rev, &html);

    EncodedNote {
        title: task.title.clone(),
        body: html,
        in_brief,
        etag,
    }
}

/// Extract `NoteMetaV1` from plain text (supporting both `ZSM1:{...}` and `ZSM1b:...`).
fn extract_meta(plain_text: &str) -> Result<Option<NoteMetaV1>, String> {
    if let Some(pos) = plain_text.find("ZSM1b:") {
        let rest = &plain_text[pos + 6..];
        let token: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if token.is_empty() {
            return Err("ZSM1b payload empty".into());
        }
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(token.as_bytes())
            .map_err(|e| format!("base64 decode failed: {e}"))?;
        let meta: NoteMetaV1 =
            serde_json::from_slice(&bytes).map_err(|e| format!("json parse failed: {e}"))?;
        return Ok(Some(meta));
    }
    if let Some(pos) = plain_text.find("ZSM1:") {
        let rest = plain_text[pos + 5..].trim_start();
        let mut de = serde_json::Deserializer::from_str(rest);
        let meta =
            NoteMetaV1::deserialize(&mut de).map_err(|e| format!("ZSM1 json parse failed: {e}"))?;
        return Ok(Some(meta));
    }
    Ok(None)
}

fn plain_text_of(html_fragment: &str) -> String {
    let stripped = strip_tags_re().replace_all(html_fragment, "\n");
    let unescaped = decode_html_entities(&stripped);
    unescaped
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Decode a raw ZSpace note into a `Task`, handling:
/// - Entity normalization (M0 finding: `&#128197;` etc.)
/// - Plain notes created in the official app (`meta_state = Missing`)
/// - Corrupted metadata (`meta_corrupted = true` so TaskService can trigger recovery)
/// - Bounded reverse-parsing if the user edited status/priority in the summary lines
pub fn decode_task_note(
    note_id: i64,
    native_title: &str,
    raw_body: &str,
    pinned: bool,
    updated_at_unix: i64,
) -> DecodedNote {
    let updated_at = if updated_at_unix > 0 {
        chrono::DateTime::from_timestamp(updated_at_unix, 0).map(|dt| dt.to_rfc3339())
    } else {
        None
    };

    let body_without_h1 = h1_re().replace(raw_body, "").into_owned();
    let sections: Vec<&str> = hr_split_re().split(&body_without_h1).collect();
    let full_plain = plain_text_of(&body_without_h1);

    let (meta_opt, meta_corrupted) = match extract_meta(&full_plain) {
        Ok(m) => (m, false),
        Err(_) => (None, true),
    };

    if let Some(mut meta) = meta_opt {
        let summary_html = sections.first().copied().unwrap_or("");
        let desc_html = if sections.len() >= 3 {
            sections[1..sections.len() - 1].join("<hr>")
        } else {
            String::new()
        };

        // Detect external summary edits after normalizing HTML entities.
        let summary_plain = plain_text_of(summary_html);
        let summary_externally_edited = meta
            .sum
            .as_deref()
            .map(|expected| short_hash(&summary_plain) != expected)
            .unwrap_or(false);

        if summary_externally_edited {
            // Bounded reverse parsing for simple fields (status & priority).
            if meta.repeat.is_none() {
                if summary_plain.contains("状态：已完成") {
                    meta.status = TaskStatus::Completed;
                } else if summary_plain.contains("状态：待办") {
                    meta.status = TaskStatus::Pending;
                }
            }
            for (needle, p) in [
                ("优先级：紧急", Priority::Urgent),
                ("优先级：高", Priority::High),
                ("优先级：普通", Priority::Normal),
                ("优先级：低", Priority::Low),
            ] {
                if summary_plain.contains(needle) {
                    meta.priority = p;
                    break;
                }
            }
        }

        let rich_body_protected = rich_html_re().is_match(&desc_html);
        let description = html_to_markdown(&desc_html);
        let raw_description_html = if rich_body_protected {
            Some(desc_html)
        } else {
            None
        };

        let etag = compute_etag(meta.rev, raw_body);
        let task = Task {
            id: note_id,
            title: native_title.to_string(),
            description,
            rich_body_protected,
            raw_description_html,
            status: meta.status,
            priority: meta.priority,
            list: meta.list,
            labels: meta.labels,
            pinned,
            schedule: meta.schedule,
            reminders: meta.reminders,
            repeat: meta.repeat,
            series: meta.series,
            attachments: meta.attachments,
            completed_at: meta.completed_at,
            created_at: meta.created_at,
            updated_at,
            source: "zspace_notebook".into(),
            meta_state: MetaState::Ok,
            rev: meta.rev,
            etag,
        };

        return DecodedNote {
            task,
            meta_present: true,
            meta_corrupted: false,
            summary_externally_edited,
        };
    }

    // No valid metadata found: either plain official note or corrupted data block.
    let desc_html = if meta_corrupted && sections.len() >= 3 {
        sections[1..sections.len() - 1].join("<hr>")
    } else {
        body_without_h1
    };
    let rich_body_protected = rich_html_re().is_match(&desc_html);
    let description = html_to_markdown(&desc_html);
    let etag = compute_etag(0, raw_body);

    let task = Task {
        id: note_id,
        title: native_title.to_string(),
        description,
        rich_body_protected,
        raw_description_html: if rich_body_protected {
            Some(desc_html)
        } else {
            None
        },
        status: TaskStatus::Pending,
        priority: Priority::Normal,
        list: None,
        labels: Vec::new(),
        pinned,
        schedule: Schedule::default(),
        reminders: Vec::new(),
        repeat: None,
        series: None,
        attachments: Vec::new(),
        completed_at: None,
        created_at: None,
        updated_at,
        source: "zspace_notebook".into(),
        meta_state: MetaState::Missing,
        rev: 0,
        etag,
    };

    DecodedNote {
        task,
        meta_present: false,
        meta_corrupted,
        summary_externally_edited: false,
    }
}

/// Ensure a due date exists for a simple helper in tests/callers.
pub fn due_point(date: &str, time: Option<&str>) -> DateTimePoint {
    DateTimePoint {
        date: date.to_string(),
        time: time.map(|s| s.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{RepeatFreq, RepeatRule};

    fn sample_task() -> Task {
        Task {
            id: 12345,
            title: "续费 eSIM".into(),
            description: "记录充值金额和[续费链接](https://example.com/esim)。\n- 核对套餐".into(),
            rich_body_protected: false,
            raw_description_html: None,
            status: TaskStatus::Active,
            priority: Priority::Normal,
            list: Some("个人".into()),
            labels: vec!["续费".into(), "eSIM".into()],
            pinned: false,
            schedule: Schedule {
                all_day: false,
                due: Some(due_point("2026-11-26", Some("18:00"))),
                timezone: "Asia/Shanghai".into(),
            },
            reminders: vec![
                Reminder::Relative {
                    id: "r1".into(),
                    offset_minutes: Some(-1440),
                    offset_days: None,
                    day_time: None,
                },
                Reminder::Relative {
                    id: "r2".into(),
                    offset_minutes: Some(-60),
                    offset_days: None,
                    day_time: None,
                },
            ],
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
                dtstart: "2026-05-26".into(),
            }),
            series: Some(SeriesState {
                cursor: "2026-11-26".into(),
                overrides: BTreeMap::new(),
                history: vec![],
                history_summary: None,
                ended_at: None,
            }),
            attachments: Vec::new(),
            completed_at: None,
            created_at: Some("2026-11-24T10:00:00+08:00".into()),
            updated_at: None,
            source: "zspace_notebook".into(),
            meta_state: MetaState::Ok,
            rev: 3,
            etag: String::new(),
        }
    }

    #[test]
    fn round_trip_with_windows_client_entity_rewrite() {
        let task = sample_task();
        let encoded = encode_task_note(&task);
        assert!(encoded.body.starts_with("<h1>续费 eSIM</h1>"));
        assert!(encoded.body.contains("<p>ZSM1:"));

        // Simulate M0 real Windows client behavior: converts 📅 -> &#128197;, 🔁 -> &#128257;,
        // and user edits one line in the description.
        let simulated_win_body = encoded
            .body
            .replace("📅", "&#128197;")
            .replace("🔁", "&#128257;")
            .replace("核对套餐", "核对套餐（已确认）");

        let decoded = decode_task_note(12345, "续费 eSIM", &simulated_win_body, false, 1795491160);
        assert!(decoded.meta_present);
        assert!(!decoded.meta_corrupted);
        assert!(
            !decoded.summary_externally_edited,
            "emoji entity encoding must NOT trigger false summary-edit detection"
        );
        assert_eq!(decoded.task.priority, Priority::Normal);
        assert_eq!(decoded.task.reminders.len(), 2);
        assert_eq!(decoded.task.repeat.as_ref().unwrap().interval, 6);
        assert!(decoded.task.description.contains("核对套餐（已确认）"));
        assert!(decoded.task.description.contains("[续费链接](https://example.com/esim)"));
    }

    #[test]
    fn plain_official_note_is_decoded_as_inbox_task() {
        let raw = "<h1>随手记</h1><p>下周买咖啡豆</p>";
        let decoded = decode_task_note(99, "随手记", raw, false, 1795491160);
        assert!(!decoded.meta_present);
        assert!(!decoded.meta_corrupted);
        assert_eq!(decoded.task.meta_state, MetaState::Missing);
        assert_eq!(decoded.task.status, TaskStatus::Pending);
        assert_eq!(decoded.task.description, "下周买咖啡豆");
    }

    #[test]
    fn corrupted_meta_is_flagged_for_recovery() {
        let raw = "<h1>续费 eSIM</h1><p>摘要</p><hr><p>新备注</p><hr><p>ZSM1:{broken json</p>";
        let decoded = decode_task_note(12345, "续费 eSIM", raw, false, 1795491160);
        assert!(!decoded.meta_present);
        assert!(decoded.meta_corrupted);
        assert_eq!(decoded.task.description, "新备注");
    }

    #[test]
    fn rich_html_is_protected() {
        let mut task = sample_task();
        let encoded = encode_task_note(&task);
        let with_img = encoded.body.replace("核对套餐", r#"核对套餐<img src="x.png">"#);
        let decoded = decode_task_note(12345, "续费 eSIM", &with_img, false, 1795491160);
        assert!(decoded.task.rich_body_protected);
        assert!(decoded
            .task
            .raw_description_html
            .as_deref()
            .unwrap()
            .contains(r#"<img src="x.png">"#));
        // Re-encoding preserves the raw HTML verbatim.
        task = decoded.task;
        let reencoded = encode_task_note(&task);
        assert!(reencoded.body.contains(r#"<img src="x.png">"#));
    }

    #[test]
    fn attachments_round_trip_in_zsm1_and_summary() {
        let mut task = sample_task();
        task.attachments = vec![TaskAttachment {
            file_id: "9001".into(),
            name: "合同.pdf".into(),
            size: Some(20480),
            resource_path: Some("/notepad/9001.pdf".into()),
            safe_dir: None,
            uploaded_at: Some("2026-11-26T08:00:00Z".into()),
        }];
        let encoded = encode_task_note(&task);
        assert!(encoded.body.contains("📎 附件 1 个（合同.pdf）"));
        let decoded = decode_task_note(12345, "续费 eSIM", &encoded.body, false, 1795491160);
        assert_eq!(decoded.task.attachments.len(), 1);
        assert_eq!(decoded.task.attachments[0].file_id, "9001");
        assert_eq!(decoded.task.attachments[0].name, "合同.pdf");
        assert_eq!(decoded.task.attachments[0].size, Some(20480));
    }
}
