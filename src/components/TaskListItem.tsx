import { Bell, Check, Pin, Repeat } from "lucide-react";
import type { Task } from "../types";
import { dateLabel, effectiveDue, isTaskOverdue, PRIORITY_META } from "../utils/date";

interface Props {
  task: Task;
  selected?: boolean;
  compact?: boolean;
  onSelect: (task: Task) => void;
  onToggle: (task: Task) => void;
}

export function TaskListItem({ task, selected, compact, onSelect, onToggle }: Props) {
  const done = task.status === "completed" || task.status === "ended";
  const due = effectiveDue(task);
  const overdue = isTaskOverdue(task);
  const pri = PRIORITY_META[task.priority];

  return (
    <div
      onClick={() => onSelect(task)}
      className={`flex cursor-pointer items-start gap-2.5 border-b border-slate-100 px-3 transition ${
        compact ? "py-1.5" : "py-2.5"
      } ${selected ? "bg-blue-50/80" : "hover:bg-slate-50"}`}
    >
      <button
        type="button"
        title={task.repeat ? "完成本次实例" : done ? "重新打开" : "标记完成"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(task);
        }}
        className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border-2 transition ${
          done
            ? "border-emerald-600 bg-emerald-600 text-white"
            : `${pri.ringClass} hover:bg-slate-100`
        }`}
      >
        {done && <Check className="h-3 w-3 stroke-[3]" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {task.pinned && <Pin className="h-3 w-3 shrink-0 text-blue-500" />}
          <span
            className={`truncate text-sm ${
              done ? "line-through text-slate-400" : "text-slate-800"
            }`}
          >
            {task.title}
          </span>
          {pri.symbol && (
            <span className={`text-xs font-bold ${pri.colorClass}`}>{pri.symbol}</span>
          )}
        </div>

        {!compact && (task.list || task.meta_state === "recovered") && (
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            {task.list && <span className="text-slate-500">{task.list}</span>}
            {task.meta_state === "recovered" && (
              <span className="text-amber-600">已自动恢复元数据</span>
            )}
          </div>
        )}
      </div>

      <div
        className={`flex shrink-0 items-center gap-1.5 text-xs ${
          overdue ? "font-medium text-red-600" : "text-slate-400"
        }`}
      >
        {task.repeat && <Repeat className="h-3.5 w-3.5" />}
        {task.reminders.length > 0 && <Bell className="h-3.5 w-3.5" />}
        {due && (
          <span>
            {dateLabel(due.date)}
            {!due.all_day && due.time ? ` ${due.time}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
