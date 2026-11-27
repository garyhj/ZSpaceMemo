import { useEffect, useState } from "react";
import { api } from "../api";
import type { RepeatFreq, RepeatRule } from "../types";
import { addDays, dateLabel, describeRepeatZh, parseDate, todayStr, weekdayCode } from "../utils/date";
import { getLunarCoords, LUNAR_DAY_NAMES, LUNAR_MONTH_NAMES } from "../utils/lunar";
import { ModalDialog } from "./Modal";

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
  const anchorLunar = getLunarCoords(anchor);

  const [rule, setRule] = useState<RepeatRule | null>(() =>
    repeat ? structuredClone(repeat) : null
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
      case "cn_workday":
        return { ...(base as RepeatRule), freq: "daily", day_filter: "cn_workday" };
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
      case "lunar_yearly":
        return {
          ...(base as RepeatRule),
          freq: "yearly",
          calendar: "lunar",
          lunar: { month: anchorLunar.month, day: anchorLunar.day, leap: "follow" },
        };
      default:
        return rule ?? { ...(base as RepeatRule), freq: "monthly", by_month_day: [anchorDate.getDate()] };
    }
  }

  function updateFreq(freq: RepeatFreq) {
    if (!rule) return;
    const isLunar = rule.calendar === "lunar" && (freq === "monthly" || freq === "yearly");
    const next: RepeatRule = {
      ...rule,
      freq,
      calendar: isLunar ? "lunar" : "gregorian",
      by_weekday: freq === "weekly" ? [weekdayCode(anchor)] : null,
      by_set_pos: null,
      by_month_day:
        !isLunar && (freq === "monthly" || freq === "yearly") ? [anchorDate.getDate()] : null,
      by_month: !isLunar && freq === "yearly" ? [anchorDate.getMonth() + 1] : null,
      lunar: isLunar
        ? {
            month: rule.lunar?.month ?? anchorLunar.month,
            day: rule.lunar?.day ?? anchorLunar.day,
            leap: rule.lunar?.leap ?? "follow",
          }
        : null,
      day_filter: null,
    };
    setRule(next);
  }

  function switchCalendar(cal: "gregorian" | "lunar") {
    if (!rule) return;
    if (cal === "lunar") {
      setRule({
        ...rule,
        calendar: "lunar",
        by_weekday: null,
        by_set_pos: null,
        by_month: null,
        by_month_day: rule.by_month_day?.[0] === -1 ? [-1] : null,
        lunar: {
          month: rule.lunar?.month ?? anchorLunar.month,
          day: rule.lunar?.day ?? anchorLunar.day,
          leap: rule.lunar?.leap ?? "follow",
        },
      });
    } else {
      setRule({
        ...rule,
        calendar: "gregorian",
        lunar: null,
        by_month: rule.freq === "yearly" ? [anchorDate.getMonth() + 1] : null,
        by_month_day:
          rule.by_month_day?.[0] === -1 ? [-1] : [anchorDate.getDate()],
      });
    }
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
    ["cn_workday", "法定工作日"],
    ["workday", "周一至周五"],
    ["lunar_yearly", "每年农历"],
    ["custom", "自定义…"],
  ];

  function isPresetSelected(k: string): boolean {
    if (k === "none") return !rule;
    if (k === "custom") return customOpen;
    if (!rule || customOpen) return false;
    if (k === "daily") return rule.freq === "daily" && !rule.day_filter && rule.interval === 1;
    if (k === "cn_workday") return rule.freq === "daily" && rule.day_filter === "cn_workday";
    if (k === "workday") return rule.freq === "daily" && rule.day_filter === "mon_fri";
    if (k === "weekly") return rule.freq === "weekly" && rule.interval === 1;
    if (k === "monthly")
      return rule.freq === "monthly" && rule.calendar !== "lunar" && rule.interval === 1;
    if (k === "half")
      return rule.freq === "monthly" && rule.calendar !== "lunar" && rule.interval === 6;
    if (k === "yearly")
      return rule.freq === "yearly" && rule.calendar !== "lunar" && rule.interval === 1;
    if (k === "lunar_yearly")
      return rule.freq === "yearly" && rule.calendar === "lunar" && rule.interval === 1;
    return false;
  }

  const isLunarMode =
    rule?.calendar === "lunar" && (rule.freq === "monthly" || rule.freq === "yearly");

  return (
    <ModalDialog
      open
      ariaLabel="自定义重复"
      onClose={onClose}
      dialogClassName="w-[min(460px,calc(100vw-2rem))]"
      className="max-h-[90vh] overscroll-contain overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
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
                isPresetSelected(k)
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
            <div className="flex flex-wrap items-center gap-2">
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

              {(rule.freq === "monthly" || rule.freq === "yearly") && (
                <div className="ml-auto flex rounded-lg bg-slate-100 p-0.5 text-[11px]">
                  {(
                    [
                      ["gregorian", "公历"],
                      ["lunar", "农历"],
                    ] as const
                  ).map(([cal, lbl]) => (
                    <button
                      key={cal}
                      type="button"
                      onClick={() => switchCalendar(cal)}
                      className={`rounded-md px-2 py-0.5 ${
                        (rule.calendar ?? "gregorian") === cal
                          ? "bg-white font-medium text-blue-600 shadow-2xs"
                          : "text-slate-500"
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {rule.freq === "daily" && (
              <div className="flex flex-wrap items-center gap-3 text-slate-600">
                <span className="w-20 text-slate-500">日期过滤</span>
                {(
                  [
                    [null, "每天"],
                    ["cn_workday", "法定工作日（含调休）"],
                    ["mon_fri", "周一至周五"],
                  ] as const
                ).map(([val, label]) => (
                  <label key={label} className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={(rule.day_filter ?? null) === val}
                      onChange={() => setRule({ ...rule, day_filter: val })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}

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

            {isLunarMode && (
              <div className="space-y-2 rounded-xl border border-amber-200/70 bg-amber-50/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-600">农历</span>
                  {rule.freq === "yearly" && (
                    <select
                      value={rule.lunar?.month ?? anchorLunar.month}
                      onChange={(e) =>
                        setRule({
                          ...rule,
                          lunar: {
                            month: Number(e.target.value),
                            day: rule.lunar?.day ?? anchorLunar.day,
                            leap: rule.lunar?.leap ?? "follow",
                          },
                        })
                      }
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                    >
                      {LUNAR_MONTH_NAMES.map((name, idx) => (
                        <option key={name} value={idx + 1}>
                          {name}
                        </option>
                      ))}
                    </select>
                  )}

                  {rule.by_month_day?.[0] === -1 ? (
                    <span className="rounded bg-white px-2 py-1 text-slate-700 border border-slate-200">
                      最后一天（大小月自动适配廿九/三十）
                    </span>
                  ) : (
                    <select
                      value={rule.lunar?.day ?? anchorLunar.day}
                      onChange={(e) =>
                        setRule({
                          ...rule,
                          by_month_day: null,
                          lunar: {
                            month: rule.lunar?.month ?? anchorLunar.month,
                            day: Number(e.target.value),
                            leap: rule.lunar?.leap ?? "follow",
                          },
                        })
                      }
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                    >
                      {LUNAR_DAY_NAMES.map((name, idx) => (
                        <option key={name} value={idx + 1}>
                          {name}
                        </option>
                      ))}
                    </select>
                  )}

                  <label className="ml-auto flex items-center gap-1 text-[11px] text-slate-600">
                    <input
                      type="checkbox"
                      checked={rule.by_month_day?.[0] === -1}
                      onChange={(e) =>
                        setRule({
                          ...rule,
                          by_month_day: e.target.checked ? [-1] : null,
                          lunar: {
                            month: rule.lunar?.month ?? anchorLunar.month,
                            day: rule.lunar?.day ?? anchorLunar.day,
                            leap: rule.lunar?.leap ?? "follow",
                          },
                        })
                      }
                    />
                    每月/腊月最后一天
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
                  <span className="text-slate-500">闰月规则</span>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={(rule.lunar?.leap ?? "follow") === "follow"}
                      onChange={() =>
                        setRule({
                          ...rule,
                          lunar: {
                            month: rule.lunar?.month ?? anchorLunar.month,
                            day: rule.lunar?.day ?? anchorLunar.day,
                            leap: "follow",
                          },
                        })
                      }
                    />
                    仅常规月（不重复触发闰月）
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={rule.lunar?.leap === "both"}
                      onChange={() =>
                        setRule({
                          ...rule,
                          lunar: {
                            month: rule.lunar?.month ?? anchorLunar.month,
                            day: rule.lunar?.day ?? anchorLunar.day,
                            leap: "both",
                          },
                        })
                      }
                    />
                    包含同号闰月
                  </label>
                </div>
              </div>
            )}

            {rule.freq === "monthly" && !isLunarMode && (
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
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={rule.end.type === "until"}
                  onChange={() =>
                    setRule({
                      ...rule,
                      end: { type: "until", until: addDays(rule.dtstart, 30) },
                    })
                  }
                />
                截至
                <input
                  type="date"
                  min={rule.dtstart}
                  value={
                    rule.end.type === "until" ? rule.end.until : addDays(rule.dtstart, 30)
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return;
                    setRule({
                      ...rule,
                      end: {
                        type: "until",
                        until: val < rule.dtstart ? rule.dtstart : val,
                      },
                    });
                  }}
                  className="rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                />
              </label>
            </div>
          </div>
        )}

        <div className="mt-3 rounded-xl bg-blue-50/70 p-2.5 text-xs">
          <div className="font-medium text-blue-900">{describeRepeatZh(rule)}</div>
          <div className="mt-1 text-slate-600">
            {rule
              ? previewDates.length > 0
                ? `接下来 5 次：${previewDates
                    .map((d) =>
                      rule.calendar === "lunar"
                        ? `${dateLabel(d)}(${getLunarCoords(d).label})`
                        : dateLabel(d)
                    )
                    .join(" → ")}`
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
    </ModalDialog>
  );
}
