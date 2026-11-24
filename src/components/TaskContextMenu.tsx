import {
  Calendar,
  CalendarPlus,
  Check,
  Copy,
  Flag,
  FolderInput,
  Pin,
  Sun,
  Sunrise,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Priority, Task } from "../types";
import { addDays, nextMonday, PRIORITY_META, todayStr } from "../utils/date";

export interface ContextMenuState {
  task: Task;
  x: number;
  y: number;
  mode?: "full" | "date";
}

interface Props {
  menu: ContextMenuState;
  lists: string[];
  onClose: () => void;
  onSetDate: (task: Task, date: string | null) => void;
  onSetPriority: (task: Task, priority: Priority) => void;
  onTogglePin: (task: Task) => void;
  onToggleDone: (task: Task) => void;
  onMoveToList: (task: Task, list: string | null) => void;
  onCopyTitle: (task: Task) => void;
  onDelete: (task: Task) => void;
}

const PRI_OPTIONS: Priority[] = ["urgent", "high", "low", "normal"];

export function TaskContextMenu({
  menu,
  lists,
  onClose,
  onSetDate,
  onSetPriority,
  onTogglePin,
  onToggleDone,
  onMoveToList,
  onCopyTitle,
  onDelete,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [showLists, setShowLists] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const { task } = menu;
  const done = task.status === "completed" || task.status === "ended";
  const t = todayStr();

  const width = menu.mode === "date" ? 188 : 228;
  const estHeight = menu.mode === "date" ? 168 : 340;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 12));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - estHeight - 12));

  const dateShortcuts: [string | null, string, React.ReactNode][] = [
    [t, "今天", <Sun className="h-3.5 w-3.5 text-amber-500" />],
    [addDays(t, 1), "明天", <Sunrise className="h-3.5 w-3.5 text-orange-500" />],
    [nextMonday(), "下周一", <CalendarPlus className="h-3.5 w-3.5 text-blue-600" />],
    [null, "无日期", <XCircle className="h-3.5 w-3.5 text-slate-400" />],
  ];

  if (menu.mode === "date") {
    return (
      <div
        ref={ref}
        style={{ left, top, width }}
        className="fixed z-50 rounded-xl border border-slate-200 bg-white p-1 text-xs shadow-xl animate-pop-in"
      >
        <div className="px-2 py-1 text-[11px] font-medium text-slate-400">快速改期</div>
        {dateShortcuts.map(([d, label, icon]) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              onSetDate(task, d);
              onClose();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-slate-700 hover:bg-slate-100"
          >
            {icon}
            <span className="flex-1">{label}</span>
            {task.schedule.due?.date === d && <Check className="h-3.5 w-3.5 text-blue-600" />}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      style={{ left, top, width }}
      className="fixed z-50 rounded-xl border border-slate-200 bg-white p-1.5 text-[13px] shadow-xl animate-pop-in"
    >
      {/* Quick date row */}
      <div className="px-1.5 pb-1 pt-0.5 text-[11px] text-slate-400">日期</div>
      <div className="grid grid-cols-4 gap-1 px-1 pb-1.5">
        {dateShortcuts.map(([d, label, icon]) => {
          const active = (task.schedule.due?.date ?? null) === d;
          return (
            <button
              key={label}
              type="button"
              title={label}
              onClick={() => {
                onSetDate(task, d);
                onClose();
              }}
              className={`flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] transition ${
                active
                  ? "bg-blue-50 font-medium text-blue-600"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {icon}
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {/* Priority flags row */}
      <div className="border-t border-slate-100 px-1.5 pb-1 pt-1.5 text-[11px] text-slate-400">
        优先级
      </div>
      <div className="grid grid-cols-4 gap-1 px-1 pb-1.5">
        {PRI_OPTIONS.map((p) => {
          const active = task.priority === p;
          return (
            <button
              key={p}
              type="button"
              title={`${PRIORITY_META[p].label}优先级`}
              onClick={() => {
                onSetPriority(task, p);
                onClose();
              }}
              className={`flex items-center justify-center rounded-lg py-1.5 transition ${
                active ? "bg-slate-100 ring-1 ring-slate-300" : "hover:bg-slate-100"
              }`}
            >
              <Flag className="h-3.5 w-3.5" style={{ color: PRIORITY_META[p].hex }} />
            </button>
          );
        })}
      </div>

      <div className="my-1 border-t border-slate-100" />

      <button
        type="button"
        onClick={() => {
          onToggleDone(task);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
      >
        <Calendar className="h-3.5 w-3.5 text-slate-400" />
        <span>{done ? "重新打开任务" : task.repeat ? "完成本次" : "标记完成"}</span>
      </button>

      <button
        type="button"
        onClick={() => {
          onTogglePin(task);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
      >
        <Pin className={`h-3.5 w-3.5 ${task.pinned ? "text-blue-600" : "text-slate-400"}`} />
        <span>{task.pinned ? "取消置顶" : "置顶"}</span>
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => setShowLists((v) => !v)}
          className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
        >
          <span className="flex items-center gap-2.5">
            <FolderInput className="h-3.5 w-3.5 text-slate-400" />
            移动到清单
          </span>
          <span className="text-[10px] text-slate-400">{task.list ?? "无"}</span>
        </button>
        {showLists && (
          <div className="mt-0.5 max-h-36 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/80 p-1">
            <button
              type="button"
              onClick={() => {
                onMoveToList(task, null);
                onClose();
              }}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-slate-500 hover:bg-white"
            >
              <span>移出清单</span>
              {!task.list && <Check className="h-3 w-3 text-blue-600" />}
            </button>
            {lists.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => {
                  onMoveToList(task, l);
                  onClose();
                }}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-white"
              >
                <span className="truncate">{l}</span>
                {task.list === l && <Check className="h-3 w-3 text-blue-600" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          onCopyTitle(task);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
      >
        <Copy className="h-3.5 w-3.5 text-slate-400" />
        <span>复制标题</span>
      </button>

      <div className="my-1 border-t border-slate-100" />

      <button
        type="button"
        onClick={() => {
          onDelete(task);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span>删除</span>
      </button>
    </div>
  );
}
