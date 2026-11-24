import type { Priority, Reminder, RepeatRule, Schedule, Task } from "../types";

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
    const key = task.series.cursor;
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
    s = r.day_filter === "mon_fri" ? "工作日（周一至周五）" : n === 1 ? "每天" : `每 ${n} 天`;
  } else if (r.freq === "weekly") {
    const wds = (r.by_weekday || [])
      .map((w) => {
        const idx = WK.indexOf(w.toUpperCase());
        return idx >= 0 ? `周${WD[idx]}` : w;
      })
      .join("、");
    s = `${n === 1 ? "每周" : `每 ${n} 周`}${wds ? " " + wds : ""}`;
  } else if (r.freq === "monthly") {
    const prefix = n === 1 ? "每月" : `每 ${n} 个月`;
    if (r.by_set_pos && r.by_weekday?.length) {
      const idx = WK.indexOf(r.by_weekday[0].toUpperCase());
      const wd = idx >= 0 ? WD[idx] : "一";
      s = `${prefix} 第${r.by_set_pos === -1 ? "最后一" : r.by_set_pos}个周${wd}`;
    } else {
      const day = r.by_month_day?.[0] ?? parseDate(r.dtstart).getDate();
      s = `${prefix} ${day === -1 ? "最后一天" : `${day} 日`}`;
    }
  } else if (r.freq === "yearly") {
    const sd = parseDate(r.dtstart);
    const m = r.by_month?.[0] ?? sd.getMonth() + 1;
    const d = r.by_month_day?.[0] ?? sd.getDate();
    s = `${n === 1 ? "每年" : `每 ${n} 年`} ${m}月${d}日`;
  }
  if (r.end.type === "count") s += `，共 ${r.end.count} 次`;
  if (r.end.type === "until") s += `，至 ${r.end.until}`;
  return s;
}

export const PRIORITY_META: Record<
  Priority,
  { label: string; symbol: string; colorClass: string; ringClass: string }
> = {
  low: { label: "低", symbol: "↓", colorClass: "text-slate-400", ringClass: "border-slate-300" },
  normal: { label: "普通", symbol: "", colorClass: "text-slate-600", ringClass: "border-slate-400" },
  high: { label: "高", symbol: "!", colorClass: "text-amber-600", ringClass: "border-amber-500" },
  urgent: { label: "紧急", symbol: "‼", colorClass: "text-red-600", ringClass: "border-red-500" },
};

export interface QuickParseResult {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  priority: Priority;
  list: string | null;
}

/** Lightweight natural-language parser for quick-add input. */
export function quickParse(
  raw: string,
  defaultDate: string | null,
  defaultPriority: Priority
): QuickParseResult {
  let title = raw;
  let dueDate = defaultDate;
  let dueTime: string | null = null;
  let priority = defaultPriority;
  let list: string | null = null;

  const t = todayStr();
  const map: Record<string, string> = {
    今天: t,
    明天: addDays(t, 1),
    后天: addDays(t, 2),
    下周一: nextMonday(),
  };

  title = title.replace(/(今天|明天|后天|下周一)/g, (m) => {
    dueDate = map[m];
    return " ";
  });
  title = title.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/, (_m, h, mi) => {
    dueTime = `${pad(Number(h))}:${mi}`;
    if (!dueDate) dueDate = t;
    return " ";
  });
  title = title.replace(/!(紧急|高|低)/, (_m, p) => {
    priority = p === "紧急" ? "urgent" : p === "高" ? "high" : "low";
    return " ";
  });
  title = title.replace(/#(\S+)/, (_m, l) => {
    list = l;
    return " ";
  });

  return {
    title: title.replace(/\s+/g, " ").trim(),
    dueDate,
    dueTime,
    priority,
    list,
  };
}
