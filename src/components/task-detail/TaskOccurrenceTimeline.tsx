import type { OccurrenceView, Schedule, Task } from "../../types";
import { dateLabel } from "../../utils/date";
import { formatTime, type UiPrefs } from "../../utils/prefs";
import { confirmAction } from "../ConfirmDialog";

interface Props {
  task: Task;
  timeline: OccurrenceView[];
  prefs: UiPrefs;
  onToggle: (task: Task) => Promise<void>;
  onSkip: (task: Task, occurrenceKey?: string) => Promise<void>;
  onReopenOccurrence: (task: Task, occurrenceKey: string) => Promise<void>;
  onOverrideOccurrence?: (task: Task, occurrenceKey: string, next: Schedule) => Promise<void>;
  onClearOccurrenceOverride?: (task: Task, occurrenceKey: string) => Promise<void>;
  onEndSeries: (task: Task) => Promise<void>;
  onEditOccurrence: (occ: OccurrenceView) => void;
}

export function TaskOccurrenceTimeline({
  task,
  timeline,
  prefs,
  onToggle,
  onSkip,
  onReopenOccurrence,
  onOverrideOccurrence,
  onClearOccurrenceOverride,
  onEndSeries,
  onEditOccurrence,
}: Props) {
  if (!task.repeat) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-700">重复实例 · 原生笔记 #{task.id}</span>
        {task.status !== "ended" && (
          <button
            type="button"
            onClick={() => {
              void (async () => {
                if (
                  await confirmAction({
                    title: "终止重复系列",
                    message: "确定终止整个重复系列？历史记录会保留，之后不再生成新实例。",
                    confirmText: "终止系列",
                    danger: true,
                  })
                ) {
                  await onEndSeries(task);
                }
              })();
            }}
            className="text-red-600 hover:underline"
          >
            终止系列
          </button>
        )}
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-1.5 divide-y divide-slate-100">
        {timeline.map((occ) => {
          const badge = {
            completed: ["✓", "text-emerald-600", "已完成"],
            skipped: ["↷", "text-slate-400", "已跳过"],
            missed: ["✕", "text-red-500", "错过"],
            pending: ["●", "text-blue-600", "待办"],
            future: ["○", "text-slate-400", "未来"],
          }[occ.state];
          const occDate = occ.schedule.due?.date ?? occ.key;
          const occTime =
            !occ.schedule.all_day && occ.schedule.due?.time
              ? ` ${formatTime(occ.schedule.due.time, prefs.timeFormat)}`
              : "";
          const canEditOcc =
            occ.state === "pending" || occ.state === "future" || occ.state === "missed";
          return (
            <div key={occ.key} className="flex items-center gap-2 py-1.5 text-xs">
              <span className={`w-3.5 shrink-0 text-center ${badge[1]}`}>{badge[0]}</span>
              <span className="min-w-0 truncate text-slate-700">
                {dateLabel(occDate)}
                {occTime}
              </span>
              <span className={`shrink-0 ${badge[1]}`}>{badge[2]}</span>
              {occ.overridden && (
                <span
                  title={`原计划：${occ.key}`}
                  className="shrink-0 rounded bg-amber-100/80 px-1 py-0.5 text-[10px] text-amber-700"
                >
                  已改期
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {occ.state === "pending" && (
                  <>
                    <button
                      type="button"
                      onClick={() => void onToggle(task)}
                      className="text-blue-600 hover:underline"
                    >
                      完成
                    </button>
                    <button
                      type="button"
                      onClick={() => void onSkip(task, occ.key)}
                      className="text-slate-500 hover:underline"
                    >
                      跳过
                    </button>
                  </>
                )}
                {canEditOcc && onOverrideOccurrence && (
                  <button
                    type="button"
                    onClick={() => onEditOccurrence(occ)}
                    className="text-slate-600 hover:text-blue-600 hover:underline"
                  >
                    改期
                  </button>
                )}
                {canEditOcc && occ.overridden && onClearOccurrenceOverride && (
                  <button
                    type="button"
                    onClick={() => void onClearOccurrenceOverride(task, occ.key)}
                    className="text-amber-600 hover:underline"
                  >
                    恢复
                  </button>
                )}
                {(occ.state === "completed" || occ.state === "skipped") && (
                  <button
                    type="button"
                    onClick={() => void onReopenOccurrence(task, occ.key)}
                    className="text-blue-600 hover:underline"
                  >
                    撤销
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
