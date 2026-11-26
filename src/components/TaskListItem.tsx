import { Bell, Calendar, Check, MoreHorizontal, Paperclip, Pin, Repeat } from "lucide-react";
import { memo, useState } from "react";
import type { Task } from "../types";
import { dueLabel, effectiveDue, isTaskOverdue, PRIORITY_META, todayStr } from "../utils/date";
import { formatTime, usePrefs } from "../utils/prefs";

interface Props {
  task: Task;
  selected?: boolean;
  compact?: boolean;
  onSelect: (task: Task) => void;
  onToggle: (task: Task) => void;
  onOpenMenu?: (task: Task, x: number, y: number, mode?: "full" | "date") => void;
}

/** Delay before a just-checked task leaves the list, so the user sees the tick + strike-through. */
const DONE_ANIM_MS = 320;

function TaskListItemImpl({ task, selected, compact, onSelect, onToggle, onOpenMenu }: Props) {
  const prefs = usePrefs();
  const [completing, setCompleting] = useState(false);
  const done = task.status === "completed" || task.status === "ended";
  const checked = done || completing;
  const due = effectiveDue(task);
  const overdue = isTaskOverdue(task);
  const isToday = due?.date === todayStr();
  const pri = PRIORITY_META[task.priority];

  function handleCheck(e: React.MouseEvent) {
    e.stopPropagation();
    if (completing) return;
    if (done) {
      onToggle(task);
      return;
    }
    setCompleting(true);
    window.setTimeout(() => {
      onToggle(task);
      setCompleting(false);
    }, DONE_ANIM_MS);
  }

  return (
    <div
      data-task-id={task.id}
      draggable={!compact}
      onDragStart={(e) => {
        if (compact) return;
        e.dataTransfer.setData("text/x-zsm-task-id", String(task.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onSelect(task)}
      onContextMenu={(e) => {
        if (!onOpenMenu) return;
        e.preventDefault();
        onSelect(task);
        onOpenMenu(task, e.clientX, e.clientY, "full");
      }}
      className={`group relative flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 transition-colors ${
        compact ? "py-1.5" : "py-2"
      } ${selected ? "bg-blue-50" : "hover:bg-slate-50"} ${
        completing && !task.repeat ? "animate-task-done" : ""
      }`}
    >
      <button
        type="button"
        title={task.repeat ? "完成本次" : done ? "重新打开" : "标记完成"}
        onClick={handleCheck}
        style={
          checked
            ? undefined
            : ({
                borderColor: pri.hex,
                "--hover-tint": `${pri.hex}22`,
              } as React.CSSProperties)
        }
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] transition-all duration-150 ${
          checked
            ? "border-slate-300 bg-slate-300 text-white"
            : "hover:scale-110 hover:bg-[color:var(--hover-tint)]"
        }`}
      >
        {checked && <Check className="h-3 w-3 stroke-[3]" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`truncate text-[13.5px] transition-colors ${
              checked ? "text-slate-400 line-through" : "text-slate-800"
            }`}
          >
            {task.title}
          </span>
          {task.pinned && <Pin className="h-3 w-3 shrink-0 rotate-45 text-blue-500" />}
        </div>

        {!compact && (task.labels.length > 0 || task.meta_state === "recovered") && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]">
            {task.labels.map((l) => (
              <span key={l} className="rounded bg-blue-50 px-1.5 text-[10.5px] text-blue-600/80">
                {l}
              </span>
            ))}
            {task.meta_state === "recovered" && (
              <span className="text-amber-600">已自动恢复元数据</span>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 text-xs">
        {task.list && !compact && (
          <span className="max-w-24 truncate text-[11px] text-slate-400 group-hover:hidden">
            {task.list}
          </span>
        )}
        {task.repeat && <Repeat className="h-3 w-3 text-slate-400" />}
        {task.reminders.length > 0 && <Bell className="h-3 w-3 text-slate-400" />}
        {(task.attachments?.length ?? 0) > 0 && (
          <span
            title={`${task.attachments!.length} 个附件`}
            className="inline-flex items-center gap-0.5 text-[10px] text-slate-400"
          >
            <Paperclip className="h-3 w-3" />
            {task.attachments!.length > 1 && <span>{task.attachments!.length}</span>}
          </span>
        )}
        {due && (
          <span
            className={`tabular-nums ${
              checked
                ? "text-slate-400"
                : overdue
                ? "text-red-500"
                : isToday
                ? "text-blue-600"
                : "text-slate-400"
            }`}
          >
            {dueLabel(due.date)}
            {!due.all_day && due.time ? ` ${formatTime(due.time, prefs.timeFormat)}` : ""}
          </span>
        )}

        {onOpenMenu && (
          <div className="hidden items-center gap-0.5 group-hover:flex">
            <button
              type="button"
              title="快速改期"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                onOpenMenu(task, r.left - 120, r.bottom + 4, "date");
              }}
              className="rounded p-1 text-slate-400 hover:bg-slate-200/70 hover:text-blue-600"
            >
              <Calendar className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="更多操作"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                onOpenMenu(task, r.left - 180, r.bottom + 4, "full");
              }}
              className="rounded p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const TaskListItem = memo(TaskListItemImpl);
