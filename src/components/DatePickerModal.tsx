import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Schedule } from "../types";
import { addDays, addMonths, dateLabel, formatDate, nextMonday, parseDate, todayStr } from "../utils/date";
import { getDayCalendarMeta } from "../utils/lunar";
import { gridOffset, usePrefs, weekdayHeaders } from "../utils/prefs";
import { ModalDialog } from "./Modal";
import { TimePicker } from "./TimePicker";

interface Props {
  schedule: Schedule;
  titleText?: string;
  singleOccurrence?: boolean;
  onSave: (next: Schedule) => void;
  onSaveAndOpenReminder?: (next: Schedule) => void;
  onSaveAndOpenRepeat?: (next: Schedule) => void;
  onClose: () => void;
}

export function DatePickerModal({
  schedule,
  titleText,
  singleOccurrence = false,
  onSave,
  onSaveAndOpenReminder,
  onSaveAndOpenRepeat,
  onClose,
}: Props) {
  const prefs = usePrefs();
  const today = todayStr();
  const [month, setMonth] = useState((schedule.due?.date ?? today).slice(0, 7));
  const [allDay, setAllDay] = useState(schedule.all_day || !schedule.due?.time);
  const [dueDate, setDueDate] = useState<string | null>(schedule.due?.date ?? null);
  const [dueTime, setDueTime] = useState<string | null>(schedule.due?.time ?? null);

  function buildSchedule(): Schedule {
    const isAllDay = allDay || !dueTime;
    return {
      all_day: isAllDay,
      due: dueDate ? { date: dueDate, time: isAllDay ? null : dueTime } : null,
      timezone: schedule.timezone || "Asia/Shanghai",
    };
  }

  function pickQuick(d: string | null) {
    setDueDate(d);
    if (d) setMonth(d.slice(0, 7));
  }

  // Build 42-day calendar grid honoring the week-start preference.
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const off = gridOffset(first, prefs.weekStart);
  const gridStart = addDays(formatDate(first), -off);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(gridStart, i);
    const dt = parseDate(d);
    return {
      date: d,
      day: dt.getDate(),
      inMonth: dt.getMonth() === m - 1,
      meta: getDayCalendarMeta(d),
    };
  });

  const quicks: [string | null, string][] = singleOccurrence
    ? [
        [today, "今天"],
        [addDays(today, 1), "明天"],
        [addDays(today, 2), "后天"],
        [nextMonday(), "下周一"],
      ]
    : [
        [today, "今天"],
        [addDays(today, 1), "明天"],
        [addDays(today, 2), "后天"],
        [nextMonday(), "下周一"],
        [null, "清除"],
      ];

  return (
    <ModalDialog
      open
      ariaLabel={titleText ?? "选择日期"}
      onClose={onClose}
      dialogClassName="w-[min(360px,calc(100vw-2rem))]"
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
    >
        {titleText && (
          <div className="mb-2.5 text-xs font-medium text-blue-700 bg-blue-50/80 rounded-lg px-2.5 py-1.5">
            {titleText}
          </div>
        )}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {quicks.map(([d, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => pickQuick(d)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                dueDate === d && d !== null
                  ? "border-transparent bg-blue-600 text-white"
                  : "border-slate-200 text-slate-600 hover:bg-slate-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setMonth(addMonths(month, -1))}
            className="rounded-lg p-1 hover:bg-slate-100"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-semibold">
            {y}年{m}月
          </span>
          <button
            type="button"
            onClick={() => setMonth(addMonths(month, 1))}
            className="rounded-lg p-1 hover:bg-slate-100"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-1 grid grid-cols-7 text-center text-[11px] text-slate-400">
          {weekdayHeaders(prefs.weekStart, "").map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((c) => {
            const isSel = dueDate === c.date;
            const isToday = c.date === today;
            return (
              <button
                key={c.date}
                type="button"
                onClick={() => setDueDate(c.date)}
                className={`relative flex h-10 flex-col items-center justify-center rounded-lg text-xs transition ${
                  isSel
                    ? "bg-blue-600 font-semibold text-white"
                    : isToday
                    ? "font-bold text-blue-600 hover:bg-blue-50"
                    : "text-slate-700 hover:bg-slate-100"
                } ${c.inMonth ? "" : "opacity-35"}`}
              >
                {c.meta.holidayBadge && (
                  <span
                    className={`absolute right-0.5 top-0.5 text-[8px] font-medium leading-none ${
                      isSel
                        ? "text-blue-100"
                        : c.meta.holidayBadge === "休"
                        ? "text-emerald-600"
                        : "text-amber-600"
                    }`}
                  >
                    {c.meta.holidayBadge}
                  </span>
                )}
                <span className="leading-tight">{c.day}</span>
                <span
                  className={`max-w-full truncate px-0.5 text-[9px] leading-none ${
                    isSel
                      ? "text-blue-100"
                      : c.meta.isHighlight
                      ? "text-blue-600"
                      : "text-slate-400"
                  }`}
                >
                  {c.meta.lunarText}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 space-y-2.5 border-t border-slate-100 pt-3 text-sm">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-slate-700">全天</span>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => {
                const checked = e.target.checked;
                setAllDay(checked);
                if (!checked && !dueTime) setDueTime("18:00");
              }}
              className="h-4 w-4 accent-blue-600"
            />
          </label>

          <div className="flex items-center justify-between">
            <span className="text-slate-700">
              截止 {dueDate ? dateLabel(dueDate) : "未设置"}
            </span>
            {dueDate ? (
              <TimePicker
                value={allDay ? null : dueTime}
                disabled={allDay}
                allowClear
                placeholder="全天"
                onChange={(t) => {
                  setDueTime(t);
                  setAllDay(!t);
                }}
              />
            ) : (
              <span className="text-xs text-slate-400">先选日期</span>
            )}
          </div>

          {!singleOccurrence && (
            <div className="flex justify-between pt-1 text-xs">
              <button
                type="button"
                onClick={() => onSaveAndOpenReminder?.(buildSchedule())}
                className="text-blue-600 hover:underline"
              >
                ⏰ 设置提醒 ›
              </button>
              <button
                type="button"
                onClick={() => onSaveAndOpenRepeat?.(buildSchedule())}
                className="text-blue-600 hover:underline"
              >
                🔁 设置重复 ›
              </button>
            </div>
          )}
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
            disabled={singleOccurrence && !dueDate}
            onClick={() => onSave(buildSchedule())}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            确定
          </button>
        </div>
    </ModalDialog>
  );
}
