import type { Priority, Reminder, RepeatRule, Schedule, Task } from "../types";
import { formatLunarDay, formatLunarMonth } from "./lunar-names";

const pad = (n: number) => String(n).padStart(2, "0");
const WD = ["日", "一", "二", "三", "四", "五", "六"];
const WK = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr(): string {
  return formatDate(new Date());
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

export function nextMonday(): string {
  const t = todayStr();
  const d = parseDate(t);
  const off = (8 - d.getDay()) % 7 || 7;
  return addDays(t, off);
}

export function dateLabel(s?: string | null): string {
  if (!s) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = todayStr();
  const dd = diffDays(t, s);
  if (dd === 0) return "今天";
  if (dd === 1) return "明天";
  if (dd === 2) return "后天";
  if (dd === -1) return "昨天";
  const d = parseDate(s);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}年` : "";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}`;
}

export function weekdayCode(s: string): string {
  return WK[parseDate(s).getDay()];
}

export function effectiveDue(task: Task): { date: string; time?: string | null; all_day: boolean } | null {
  if (task.repeat && task.series) {
    const key = task.effective_current_key ?? task.series.cursor;
    const ov = task.series.overrides?.[key]?.schedule;
    if (ov?.due) {
      return { date: ov.due.date, time: ov.due.time, all_day: ov.all_day };
    }
    return {
      date: key,
      time: task.schedule.all_day ? null : task.schedule.due?.time ?? null,
      all_day: task.schedule.all_day,
    };
  }
  if (!task.schedule.due) return null;
  return {
    date: task.schedule.due.date,
    time: task.schedule.all_day ? null : task.schedule.due.time ?? null,
    all_day: task.schedule.all_day,
  };
}

export function isTaskOverdue(task: Task): boolean {
  if (task.status === "completed" || task.status === "ended") return false;
  if (typeof task.is_overdue === "boolean") return task.is_overdue;
  const due = effectiveDue(task);
  if (!due) return false;
  if (!due.all_day && due.time) {
    return new Date(`${due.date}T${due.time}`) < new Date();
  }
  return due.date < todayStr();
}

export function reminderLabel(r: Reminder): string {
  if (r.type === "absolute") return `于 ${r.at.replace("T", " ")}`;
  if (r.offset_days !== undefined && r.offset_days !== null) {
    const t = r.day_time || "09:00";
    return r.offset_days === 0 ? `当天 ${t}` : `提前 ${Math.abs(r.offset_days)} 天 ${t}`;
  }
  const m = Math.abs(r.offset_minutes ?? 0);
  if (m === 0) return "到期时";
  if (m % 1440 === 0) return `提前 ${m / 1440} 天`;
  if (m % 60 === 0) return `提前 ${m / 60} 小时`;
  return `提前 ${m} 分钟`;
}

export function previewFireTime(r: Reminder, schedule: Schedule, defaultDayTime = "09:00"): string | null {
  if (r.type === "absolute") return r.at.replace("T", " ");
  const due = schedule.due;
  if (!due) return null;
  if (r.offset_days !== undefined && r.offset_days !== null) {
    return `${addDays(due.date, r.offset_days)} ${r.day_time || defaultDayTime}`;
  }
  const baseTime = schedule.all_day || !due.time ? defaultDayTime : due.time;
  const dt = new Date(`${due.date}T${baseTime}`);
  dt.setMinutes(dt.getMinutes() + (r.offset_minutes ?? 0));
  return `${formatDate(dt)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function describeRepeatZh(r?: RepeatRule | null): string {
  if (!r) return "不重复";
  const n = Math.max(1, r.interval || 1);
  let s = "";
  if (r.freq === "daily") {
    s =
      r.day_filter === "cn_workday"
        ? "法定工作日（含调休）"
        : r.day_filter === "mon_fri"
        ? "工作日（周一至周五）"
        : n === 1
        ? "每天"
        : `每 ${n} 天`;
  } else if (r.freq === "weekly") {
    const wds = (r.by_weekday || [])
      .map((w) => {
        const idx = WK.indexOf(w.toUpperCase());
        return idx >= 0 ? `周${WD[idx]}` : w;
      })
      .join("、");
    s = `${n === 1 ? "每周" : `每 ${n} 周`}${wds ? " " + wds : ""}`;
  } else if (r.freq === "monthly") {
    if (r.calendar === "lunar") {
      const prefix = n === 1 ? "每农历月" : `每 ${n} 个农历月`;
      const isLast = r.by_month_day?.[0] === -1;
      const dayS = isLast
        ? "最后一天"
        : r.lunar?.day
        ? formatLunarDay(r.lunar.day)
        : "指定农历日";
      const leapHint = r.lunar?.leap === "both" ? "（含闰月）" : "";
      s = `${prefix} ${dayS}${leapHint}`;
    } else {
      const prefix = n === 1 ? "每月" : `每 ${n} 个月`;
      if (r.by_set_pos && r.by_weekday?.length) {
        const idx = WK.indexOf(r.by_weekday[0].toUpperCase());
        const wd = idx >= 0 ? WD[idx] : "一";
        s = `${prefix} 第${r.by_set_pos === -1 ? "最后一" : r.by_set_pos}个周${wd}`;
      } else {
        const day = r.by_month_day?.[0] ?? parseDate(r.dtstart).getDate();
        s = `${prefix} ${day === -1 ? "最后一天" : `${day} 日`}`;
      }
    }
  } else if (r.freq === "yearly") {
    if (r.calendar === "lunar") {
      const prefix = n === 1 ? "每年" : `每 ${n} 年`;
      const m = r.lunar?.month;
      const isLast = r.by_month_day?.[0] === -1;
      const dayS = isLast
        ? "最后一天"
        : r.lunar?.day
        ? formatLunarDay(r.lunar.day)
        : "";
      const monthS = m ? formatLunarMonth(m) : "农历";
      const leapHint =
        r.lunar?.leap === "both"
          ? "（含闰月）"
          : r.lunar?.leap === "only_leap"
          ? "（仅闰月）"
          : "";
      s = `${prefix} 农历${monthS}${dayS}${leapHint}`;
    } else {
      const sd = parseDate(r.dtstart);
      const m = r.by_month?.[0] ?? sd.getMonth() + 1;
      const d = r.by_month_day?.[0] ?? sd.getDate();
      s = `${n === 1 ? "每年" : `每 ${n} 年`} ${m}月${d}日`;
    }
  }
  if (r.end.type === "count") s += `，共 ${r.end.count} 次`;
  if (r.end.type === "until") s += `，至 ${r.end.until}`;
  return s;
}

export const PRIORITY_META: Record<
  Priority,
  { label: string; symbol: string; colorClass: string; ringClass: string; hex: string }
> = {
  low: { label: "低", symbol: "↓", colorClass: "text-blue-600", ringClass: "border-blue-600", hex: "#4772FA" },
  normal: { label: "普通", symbol: "", colorClass: "text-slate-400", ringClass: "border-slate-300", hex: "#B8BCC4" },
  high: { label: "高", symbol: "!", colorClass: "text-amber-500", ringClass: "border-amber-500", hex: "#F59F00" },
  urgent: { label: "紧急", symbol: "‼", colorClass: "text-red-600", ringClass: "border-red-600", hex: "#E03131" },
};

const LIST_PALETTE = [
  "#4772FA",
  "#10B981",
  "#F59F00",
  "#8B5CF6",
  "#F43F5E",
  "#06B6D4",
];

export function listColorHex(name?: string | null): string | null {
  if (!name) return null;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return LIST_PALETTE[h % LIST_PALETTE.length];
}

/**
 * Compact, human-friendly due label for list rows (Dida365 style):
 * 今天 / 明天 / 昨天 / 周四（7 天内）/ 11月28日（今年）/ 2027/1/3（跨年）。
 */
export function dueLabel(date?: string | null): string {
  if (!date) return "";
  const t = todayStr();
  const dd = diffDays(t, date);
  if (dd === 0) return "今天";
  if (dd === 1) return "明天";
  if (dd === -1) return "昨天";
  const d = parseDate(date);
  if (dd > 1 && dd < 7) return `周${WD[d.getDay()]}`;
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export type QuickTokenKind = "date" | "time" | "pri" | "list";

export interface QuickToken {
  kind: QuickTokenKind;
  start: number;
  end: number;
}

export interface QuickParseResult {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  priority: Priority;
  list: string | null;
  /** Character ranges in `raw` that were recognized (for inline highlighting). */
  tokens: QuickToken[];
}

const QUICK_RE =
  /(?<date>大后天|今天|明天|后天|下周[一二三四五六日天]|周[一二三四五六日天])|(?<time>(?:上午|早上|中午|下午|晚上)?(?:[01]?\d|2[0-3])点(?:半|[0-5]?\d分?)?|(?<![\d:：])(?:[01]?\d|2[0-3])[:：][0-5]\d(?![\d:：]))|(?<pri>[!！](?:紧急|高|低|普通))|(?<list>#[^\s#]+)/g;

const WD_IDX: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

function resolveDateWord(w: string): string {
  const t = todayStr();
  if (w === "今天") return t;
  if (w === "明天") return addDays(t, 1);
  if (w === "后天") return addDays(t, 2);
  if (w === "大后天") return addDays(t, 3);
  const target = WD_IDX[w.slice(-1)];
  if (w.startsWith("下周")) {
    // Monday-based "next week"
    return addDays(nextMonday(), (target + 6) % 7);
  }
  const cur = parseDate(t).getDay();
  return addDays(t, (target - cur + 7) % 7);
}

function resolveTimeWord(w: string): string | null {
  const m1 = w.match(/^(?:[01]?\d|2[0-3])[:：]([0-5]\d)$/);
  if (m1) {
    const [h, mi] = w.split(/[:：]/);
    return `${pad(Number(h))}:${mi}`;
  }
  const m2 = w.match(/^(上午|早上|中午|下午|晚上)?(\d{1,2})点(半|(\d{1,2})分?)?$/);
  if (!m2) return null;
  let h = Number(m2[2]);
  const period = m2[1];
  if ((period === "下午" || period === "晚上") && h < 12) h += 12;
  if (period === "中午" && h < 5) h += 12;
  const mi = m2[3] === "半" ? 30 : m2[4] ? Number(m2[4]) : 0;
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}:${pad(mi)}`;
}

/** Lightweight natural-language parser for quick-add input. */
export function quickParse(
  raw: string,
  defaultDate: string | null,
  defaultPriority: Priority,
  defaultList: string | null = null
): QuickParseResult {
  let dueDate = defaultDate;
  let dueTime: string | null = null;
  let priority = defaultPriority;
  let list: string | null = defaultList;
  const tokens: QuickToken[] = [];
  const seen = new Set<QuickTokenKind>();

  for (const m of raw.matchAll(QUICK_RE)) {
    const g = m.groups ?? {};
    const kind: QuickTokenKind | null = g.date
      ? "date"
      : g.time
      ? "time"
      : g.pri
      ? "pri"
      : g.list
      ? "list"
      : null;
    if (!kind || seen.has(kind)) continue;
    const text = m[0];
    if (kind === "date") dueDate = resolveDateWord(text);
    if (kind === "time") {
      const tm = resolveTimeWord(text);
      if (!tm) continue;
      dueTime = tm;
    }
    if (kind === "pri") {
      const p = text.slice(1);
      priority = p === "紧急" ? "urgent" : p === "高" ? "high" : p === "低" ? "low" : "normal";
    }
    if (kind === "list") list = text.slice(1);
    seen.add(kind);
    tokens.push({ kind, start: m.index ?? 0, end: (m.index ?? 0) + text.length });
  }

  if (dueTime && !dueDate) dueDate = todayStr();

  let title = "";
  let cursor = 0;
  for (const tk of tokens) {
    title += raw.slice(cursor, tk.start) + " ";
    cursor = tk.end;
  }
  title += raw.slice(cursor);

  return {
    title: title.replace(/\s+/g, " ").trim(),
    dueDate,
    dueTime,
    priority,
    list,
    tokens,
  };
}
