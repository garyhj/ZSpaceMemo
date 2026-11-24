import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Schedule } from "../types";
import { addDays, addMonths, dateLabel, formatDate, nextMonday, parseDate, todayStr } from "../utils/date";

interface Props {
  schedule: Schedule;
  onSave: (next: Schedule) => void;
  onSaveAndOpenReminder: (next: Schedule) => void;
  onSaveAndOpenRepeat: (next: Schedule) => void;
  onClose: () => void;
}

export function DatePickerModal({
  schedule,
  onSave,
  onSaveAndOpenReminder,
  onSaveAndOpenRepeat,
  onClose,
}: Props) {
  const today = todayStr();
  const [month, setMonth] = useState((schedule.due?.date ?? today).slice(0, 7));
  const [allDay, setAllDay] = useState(schedule.all_day);
  const [dueDate, setDueDate] = useState<string | null>(schedule.due?.date ?? null);
  const [dueTime, setDueTime] = useState<string>(schedule.due?.time ?? "18:00");

  function buildSchedule(): Schedule {
    return {
      all_day: allDay,
      due: dueDate ? { date: dueDate, time: allDay ? null : dueTime || null } : null,
      timezone: schedule.timezone || "Asia/Shanghai",
    };
  }

  function pickQuick(d: string | null) {
    setDueDate(d);
    if (d) setMonth(d.slice(0, 7));
  }

  // Build 42-day calendar grid starting Monday.
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const off = (first.getDay() + 6) % 7;
  const gridStart = addDays(formatDate(first), -off);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(gridStart, i);
    const dt = parseDate(d);
    return {
      date: d,
      day: dt.getDate(),
      inMonth: dt.getMonth() === m - 1,
      weekend: dt.getDay() === 0 || dt.getDay() === 6,
    };
  });

  const quicks: [string | null, string][] = [
    [today, "今天"],
    [addDays(today, 1), "明天"],
    [addDays(today, 2), "后天"],
    [nextMonday(), "下周一"],
    [null, "清除"],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[360px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
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
          {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
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
                className={`flex h-9 flex-col items-center justify-center rounded-lg text-xs transition ${
                  isSel
                    ? "bg-blue-600 font-semibold text-white"
                    : isToday
                    ? "font-bold text-blue-600 hover:bg-blue-50"
                    : "text-slate-700 hover:bg-slate-100"
                } ${c.inMonth ? "" : "opacity-35"}`}
              >
                <span>{c.day}</span>
                <span className={`text-[9px] leading-none ${isSel ? "text-blue-100" : c.weekend ? "text-red-400" : "text-slate-300"}`}>
                  {c.weekend ? "末" : ""}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-1.5 text-[11px] text-slate-400">
          农历 / 节气 / 休·班标记位置已预留（P2）
        </div>

        <div className="mt-3 space-y-2.5 border-t border-slate-100 pt-3 text-sm">
          <label className="flex items-center justify-between">
            <span className="text-slate-700">全天</span>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="h-4 w-4 accent-blue-600"
            />
          </label>

          <div className="flex items-center justify-between">
            <span className="text-slate-700">
              截止 {dueDate ? dateLabel(dueDate) : "未设置"}
            </span>
            {dueDate ? (
              <input
                type="time"
                step={900}
                disabled={allDay}
                value={allDay ? "" : dueTime}
                onChange={(e) => setDueTime(e.target.value)}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-40"
              />
            ) : (
              <span className="text-xs text-slate-400">先选日期</span>
            )}
          </div>

          <div className="flex justify-between pt-1 text-xs">
            <button
              type="button"
              onClick={() => onSaveAndOpenReminder(buildSchedule())}
              className="text-blue-600 hover:underline"
            >
              ⏰ 设置提醒 ›
            </button>
            <button
              type="button"
              onClick={() => onSaveAndOpenRepeat(buildSchedule())}
              className="text-blue-600 hover:underline"
            >
              🔁 设置重复 ›
            </button>
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
            onClick={() => onSave(buildSchedule())}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
