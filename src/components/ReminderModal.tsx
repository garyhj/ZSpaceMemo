import { X } from "lucide-react";
import { useState } from "react";
import type { Reminder, Schedule } from "../types";
import { previewFireTime, reminderLabel } from "../utils/date";
import { ModalDialog } from "./Modal";

interface Props {
  schedule: Schedule;
  reminders: Reminder[];
  defaultAllDayTime?: string;
  onSave: (next: Reminder[]) => void;
  onClose: () => void;
}

function keyOf(r: Reminder): string {
  if (r.type === "absolute") return `abs:${r.at}`;
  return `rel:${r.offset_minutes ?? ""}:${r.offset_days ?? ""}:${r.day_time ?? ""}`;
}

export function ReminderModal({
  schedule,
  reminders,
  defaultAllDayTime = "09:00",
  onSave,
  onClose,
}: Props) {
  const [list, setList] = useState<Reminder[]>(() => reminders.map((r) => ({ ...r })));
  const [customNum, setCustomNum] = useState(1);
  const [customUnit, setCustomUnit] = useState<"m" | "h" | "d" | "w">("h");

  const isAllDay = schedule.all_day || Boolean(schedule.due && !schedule.due.time);

  const presets: Reminder[] = isAllDay
    ? [
        { type: "relative", id: "p0", offset_days: 0, day_time: defaultAllDayTime },
        { type: "relative", id: "p1", offset_days: -1, day_time: defaultAllDayTime },
        { type: "relative", id: "p2", offset_days: -2, day_time: defaultAllDayTime },
        { type: "relative", id: "p7", offset_days: -7, day_time: defaultAllDayTime },
      ]
    : [0, -5, -10, -15, -30, -60, -1440].map((m) => ({
        type: "relative",
        id: `pm${Math.abs(m)}`,
        offset_minutes: m,
      }));

  function toggle(r: Reminder) {
    const k = keyOf(r);
    const idx = list.findIndex((x) => keyOf(x) === k);
    if (idx >= 0) {
      setList(list.filter((_, i) => i !== idx));
    } else {
      setList([...list, { ...r, id: `r_${crypto.randomUUID()}` }]);
    }
  }

  function addCustom() {
    const mult = { m: 1, h: 60, d: 1440, w: 10080 }[customUnit];
    const mins = -Math.max(1, customNum) * mult;
    toggle({ type: "relative", id: `c_${crypto.randomUUID()}`, offset_minutes: mins });
  }

  return (
    <ModalDialog
      open
      ariaLabel="提醒设置"
      onClose={onClose}
      dialogClassName="w-[min(390px,calc(100vw-2rem))]"
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
    >
        <div className="font-semibold text-sm">提醒设置</div>
        <p className="mt-0.5 text-xs text-slate-500">
          提醒与截止时间相互独立，支持设置多个。由桌面端常驻托盘调度；关机错过的提醒将在下次开机时补发。
        </p>

        {!schedule.due && (
          <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
            该任务尚未设置截止日期，相对提醒暂不会生效。
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
          {presets.map((p) => {
            const active = list.some((x) => keyOf(x) === keyOf(p));
            return (
              <button
                key={keyOf(p)}
                type="button"
                onClick={() => toggle(p)}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${
                  active
                    ? "border-transparent bg-blue-600 text-white"
                    : "border-slate-200 text-slate-700 hover:bg-slate-100"
                }`}
              >
                {reminderLabel(p)}
              </button>
            );
          })}
        </div>

        {!isAllDay && (
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="text-slate-600">自定义提前</span>
            <input
              type="number"
              min={1}
              value={customNum}
              onChange={(e) => setCustomNum(Math.max(1, Number(e.target.value) || 1))}
              className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-center"
            />
            <select
              value={customUnit}
              onChange={(e) => setCustomUnit(e.target.value as "m" | "h" | "d" | "w")}
              className="rounded-lg border border-slate-200 px-2 py-1"
            >
              <option value="m">分钟</option>
              <option value="h">小时</option>
              <option value="d">天</option>
              <option value="w">周</option>
            </select>
            <button
              type="button"
              onClick={addCustom}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-slate-700 hover:bg-slate-50"
            >
              添加
            </button>
          </div>
        )}

        <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-xs">
          <div className="font-medium text-slate-700">已设置（预计触发时刻）</div>
          {list.length === 0 ? (
            <div className="text-slate-400">不提醒</div>
          ) : (
            list.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2">
                <span className="text-slate-700">{reminderLabel(r)}</span>
                <span className="text-slate-400">
                  {previewFireTime(r, schedule, defaultAllDayTime) ?? "—（缺少截止日期）"}
                </span>
                <button
                  type="button"
                  onClick={() => toggle(r)}
                  className="text-slate-400 hover:text-red-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
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
            onClick={() => onSave(list)}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            确定
          </button>
        </div>
    </ModalDialog>
  );
}
