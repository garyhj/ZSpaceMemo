import { useEffect, useState } from "react";
import { api } from "../api";
import type { RepeatFreq, RepeatRule } from "../types";
import { dateLabel, describeRepeatZh, parseDate, todayStr, weekdayCode } from "../utils/date";

interface Props {
  baseDate: string | null;
  repeat: RepeatRule | null;
  onSave: (rule: RepeatRule | null) => void;
  onClose: () => void;
}

const WEEKDAYS = [
  ["MO", "一"],
  ["TU", "二"],
  ["WE", "三"],
  ["TH", "四"],
  ["FR", "五"],
  ["SA", "六"],
  ["SU", "日"],
] as const;

export function RepeatModal({ baseDate, repeat, onSave, onClose }: Props) {
  const anchor = baseDate || todayStr();
  const anchorDate = parseDate(anchor);

  const [rule, setRule] = useState<RepeatRule | null>(() =>
    repeat ? JSON.parse(JSON.stringify(repeat)) : null
  );
  const [customOpen, setCustomOpen] = useState(Boolean(repeat));
  const [previewDates, setPreviewDates] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    if (!rule) {
      setPreviewDates([]);
      return;
    }
    api
      .previewRepeat(rule, 5)
      .then((res) => {
        if (active) setPreviewDates(res.dates);
      })
      .catch(() => {
        if (active) setPreviewDates([]);
      });
    return () => {
      active = false;
    };
  }, [rule]);

  function makePreset(kind: string): RepeatRule | null {
    const base: Partial<RepeatRule> = {
      interval: 1,
      calendar: "gregorian",
      on_invalid_date: "clamp",
      basis: "schedule",
      catch_up: "latest",
      end: { type: "never" },
      dtstart: anchor,
    };
    switch (kind) {
      case "none":
        return null;
      case "daily":
        return { ...(base as RepeatRule), freq: "daily" };
      case "workday":
        return { ...(base as RepeatRule), freq: "daily", day_filter: "mon_fri" };
      case "weekly":
        return { ...(base as RepeatRule), freq: "weekly", by_weekday: [weekdayCode(anchor)] };
      case "monthly":
        return { ...(base as RepeatRule), freq: "monthly", by_month_day: [anchorDate.getDate()] };
      case "half":
        return {
          ...(base as RepeatRule),
          freq: "monthly",
          interval: 6,
          by_month_day: [anchorDate.getDate()],
        };
      case "yearly":
        return {
          ...(base as RepeatRule),
          freq: "yearly",
          by_month: [anchorDate.getMonth() + 1],
          by_month_day: [anchorDate.getDate()],
        };
      default:
        return rule ?? { ...(base as RepeatRule), freq: "monthly", by_month_day: [anchorDate.getDate()] };
    }
  }

  function updateFreq(freq: RepeatFreq) {
    if (!rule) return;
    const next: RepeatRule = {
      ...rule,
      freq,
      by_weekday: freq === "weekly" ? [weekdayCode(anchor)] : null,
      by_set_pos: null,
      by_month_day:
        freq === "monthly" || freq === "yearly" ? [anchorDate.getDate()] : null,
      by_month: freq === "yearly" ? [anchorDate.getMonth() + 1] : null,
      day_filter: null,
    };
    setRule(next);
  }

  function toggleWeekday(code: string) {
    if (!rule) return;
    const cur = rule.by_weekday ?? [];
    const next = cur.includes(code)
      ? cur.length > 1
        ? cur.filter((x) => x !== code)
        : cur
      : [...cur, code];
    setRule({ ...rule, by_weekday: next });
  }

  const presets: [string, string][] = [
    ["none", "不重复"],
    ["daily", "每天"],
    ["weekly", "每周"],
    ["monthly", "每月"],
    ["half", "每半年"],
    ["yearly", "每年"],
    ["workday", "工作日"],
    ["custom", "自定义…"],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-[440px] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <span className="font-semibold text-sm">重复规则</span>
          <span className="text-[11px] text-slate-400">整个系列对应一条极空间笔记</span>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {presets.map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                if (k === "custom") {
                  setCustomOpen(true);
                  if (!rule) setRule(makePreset("monthly"));
                } else {
                  setCustomOpen(false);
                  setRule(makePreset(k));
                }
              }}
              className={`rounded-full border px-2.5 py-1 text-xs transition ${
                (k === "none" && !rule) || (k === "custom" && customOpen)
                  ? "border-transparent bg-blue-600 text-white"
                  : "border-slate-200 text-slate-700 hover:bg-slate-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {rule && customOpen && (
          <div className="mt-3 space-y-2.5 border-t border-slate-100 pt-3 text-xs">
            <div className="flex items-center gap-2">
              <span>每</span>
              <input
                type="number"
                min={1}
                value={rule.interval}
                onChange={(e) =>
                  setRule({ ...rule, interval: Math.max(1, Number(e.target.value) || 1) })
                }
                className="w-14 rounded-lg border border-slate-200 px-2 py-1 text-center"
              />
              <select
                value={rule.freq}
                onChange={(e) => updateFreq(e.target.value as RepeatFreq)}
                className="rounded-lg border border-slate-200 px-2 py-1"
              >
                <option value="daily">天</option>
                <option value="weekly">周</option>
                <option value="monthly">个月</option>
                <option value="yearly">年</option>
              </select>
              {rule.freq === "daily" && (
                <label className="ml-2 flex items-center gap-1 text-slate-600">
                  <input
                    type="checkbox"
                    checked={rule.day_filter === "mon_fri"}
                    onChange={(e) =>
                      setRule({ ...rule, day_filter: e.target.checked ? "mon_fri" : null })
                    }
                  />
                  仅工作日
                </label>
              )}
            </div>

            {rule.freq === "weekly" && (
              <div className="flex gap-1">
                {WEEKDAYS.map(([code, zh]) => {
                  const on = rule.by_weekday?.includes(code);
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => toggleWeekday(code)}
                      className={`h-7 w-7 rounded-full border text-xs ${
                        on
                          ? "border-transparent bg-blue-600 text-white"
                          : "border-slate-200 text-slate-600"
                      }`}
                    >
                      {zh}
                    </button>
                  );
                })}
              </div>
            )}

            {rule.freq === "monthly" && (
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={!rule.by_set_pos && rule.by_month_day?.[0] !== -1}
                    onChange={() =>
                      setRule({
                        ...rule,
                        by_set_pos: null,
                        by_weekday: null,
                        by_month_day: [anchorDate.getDate()],
                      })
                    }
                  />
                  <span>每月</span>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={
                      rule.by_month_day?.[0] && rule.by_month_day[0] > 0
                        ? rule.by_month_day[0]
                        : anchorDate.getDate()
                    }
                    onChange={(e) =>
                      setRule({
                        ...rule,
                        by_set_pos: null,
                        by_weekday: null,
                        by_month_day: [Math.min(31, Math.max(1, Number(e.target.value) || 1))],
                      })
                    }
                    className="w-12 rounded border border-slate-200 px-1 py-0.5 text-center"
                  />
                  <span>日</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={!rule.by_set_pos && rule.by_month_day?.[0] === -1}
                    onChange={() =>
                      setRule({ ...rule, by_set_pos: null, by_weekday: null, by_month_day: [-1] })
                    }
                  />
                  <span>每月最后一天</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={Boolean(rule.by_set_pos)}
                    onChange={() =>
                      setRule({
                        ...rule,
                        by_month_day: null,
                        by_set_pos: 1,
                        by_weekday: ["MO"],
                      })
                    }
                  />
                  <span>每月第</span>
                  <select
                    value={rule.by_set_pos ?? 1}
                    onChange={(e) =>
                      setRule({
                        ...rule,
                        by_month_day: null,
                        by_set_pos: Number(e.target.value),
                        by_weekday: rule.by_weekday ?? ["MO"],
                      })
                    }
                    className="rounded border border-slate-200 px-1 py-0.5"
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                    <option value={-1}>最后一</option>
                  </select>
                  <span>个</span>
                  <select
                    value={rule.by_weekday?.[0] ?? "MO"}
                    onChange={(e) =>
                      setRule({
                        ...rule,
                        by_month_day: null,
                        by_set_pos: rule.by_set_pos ?? 1,
                        by_weekday: [e.target.value],
                      })
                    }
                    className="rounded border border-slate-200 px-1 py-0.5"
                  >
                    {WEEKDAYS.map(([code, zh]) => (
                      <option key={code} value={code}>
                        周{zh}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {(rule.freq === "monthly" || rule.freq === "yearly") && (
              <div className="flex items-center gap-3">
                <span className="w-20 text-slate-500">不存在的日期</span>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={rule.on_invalid_date !== "skip"}
                    onChange={() => setRule({ ...rule, on_invalid_date: "clamp" })}
                  />
                  顺延到月末
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={rule.on_invalid_date === "skip"}
                    onChange={() => setRule({ ...rule, on_invalid_date: "skip" })}
                  />
                  跳过
                </label>
              </div>
            )}

            <div className="flex items-center gap-3">
              <span className="w-20 text-slate-500">逾期策略</span>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={rule.catch_up !== "each"}
                  onChange={() => setRule({ ...rule, catch_up: "latest" })}
                />
                跳到最近一期
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={rule.catch_up === "each"}
                  onChange={() => setRule({ ...rule, catch_up: "each" })}
                />
                逐期补做
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="w-20 text-slate-500">结束</span>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={rule.end.type === "never"}
                  onChange={() => setRule({ ...rule, end: { type: "never" } })}
                />
                永不
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={rule.end.type === "count"}
                  onChange={() => setRule({ ...rule, end: { type: "count", count: 10 } })}
                />
                共
                <input
                  type="number"
                  min={1}
                  value={rule.end.type === "count" ? rule.end.count : 10}
                  onChange={(e) =>
                    setRule({
                      ...rule,
                      end: { type: "count", count: Math.max(1, Number(e.target.value) || 1) },
                    })
                  }
                  className="w-12 rounded border border-slate-200 px-1 py-0.5 text-center"
                />
                次
              </label>
            </div>
          </div>
        )}

        <div className="mt-3 rounded-xl bg-blue-50/70 p-2.5 text-xs">
          <div className="font-medium text-blue-900">{describeRepeatZh(rule)}</div>
          <div className="mt-1 text-slate-600">
            {rule
              ? previewDates.length > 0
                ? `接下来 5 次：${previewDates.map((d) => dateLabel(d)).join(" → ")}`
                : "正在计算预览…"
              : "该任务只执行一次"}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(rule)}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
