import {
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Repeat,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { CalendarTaskItem, CreateTaskInput, Priority } from "../types";
import { addDays, addMonths, formatDate, parseDate, todayStr } from "../utils/date";
import { getDayCalendarMeta } from "../utils/lunar";
import { formatTime, gridOffset, usePrefs, weekdayHeaders } from "../utils/prefs";

interface Props {
  lists: string[];
  selectedTaskId: number | null;
  refreshToken: number;
  onSelectTask: (taskId: number) => void;
  onCreateTaskOnDate: (input: CreateTaskInput) => Promise<void>;
  onRescheduleItem: (item: CalendarTaskItem, targetDate: string) => Promise<void>;
  onToggleItem: (item: CalendarTaskItem) => Promise<void>;
  onContextMenuTask?: (taskId: number, x: number, y: number) => void;
  onSync: () => Promise<void>;
  busy?: boolean;
}

const PILL_COLOR: Record<Priority, string> = {
  urgent: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100",
  high: "bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100",
  normal: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100",
  low: "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200/70",
};

export function MonthCalendarView({
  lists,
  selectedTaskId,
  refreshToken,
  onSelectTask,
  onCreateTaskOnDate,
  onRescheduleItem,
  onToggleItem,
  onContextMenuTask,
  onSync,
  busy,
}: Props) {
  const today = todayStr();
  const prefs = usePrefs();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [items, setItems] = useState<CalendarTaskItem[]>([]);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [listFilter, setListFilter] = useState<string>("");
  const [quickAddDate, setQuickAddDate] = useState<string | null>(null);
  const [quickTitle, setQuickTitle] = useState("");
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);

  const { cells, rangeFrom, rangeTo, year, monthNum } = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const off = gridOffset(first, prefs.weekStart);
    const start = addDays(formatDate(first), -off);
    const arr = Array.from({ length: 42 }, (_, i) => {
      const date = addDays(start, i);
      const dt = parseDate(date);
      return {
        date,
        day: dt.getDate(),
        inMonth: dt.getMonth() === m - 1,
        weekend: dt.getDay() === 0 || dt.getDay() === 6,
        meta: getDayCalendarMeta(date),
      };
    });
    return {
      cells: arr,
      rangeFrom: arr[0].date,
      rangeTo: arr[41].date,
      year: y,
      monthNum: m,
    };
  }, [month, prefs.weekStart]);

  useEffect(() => {
    let active = true;
    api
      .listCalendarItems(rangeFrom, rangeTo, includeCompleted)
      .then((res) => {
        if (active) setItems(res);
      })
      .catch(() => {
        if (active) setItems([]);
      });
    return () => {
      active = false;
    };
  }, [rangeFrom, rangeTo, includeCompleted, refreshToken]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarTaskItem[]>();
    for (const item of items) {
      if (listFilter && (item.list ?? "") !== listFilter) continue;
      const list = map.get(item.date) ?? [];
      list.push(item);
      map.set(item.date, list);
    }
    return map;
  }, [items, listFilter]);

  async function submitQuickAdd(date: string) {
    const t = quickTitle.trim();
    if (!t) {
      setQuickAddDate(null);
      return;
    }
    await onCreateTaskOnDate({
      title: t,
      list: listFilter || null,
      schedule: {
        all_day: true,
        due: { date, time: null },
        timezone: "Asia/Shanghai",
      },
    });
    setQuickTitle("");
    setQuickAddDate(null);
  }

  function handleDragStart(e: React.DragEvent, item: CalendarTaskItem) {
    e.dataTransfer.setData("application/json", JSON.stringify(item));
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDrop(e: React.DragEvent, targetDate: string) {
    e.preventDefault();
    setDragOverDate(null);
    const raw = e.dataTransfer.getData("application/json");
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as CalendarTaskItem;
      if (item.date !== targetDate) {
        // Optimistic move on frame 0
        setItems((prev) =>
          prev.map((x) =>
            x.task_id === item.task_id &&
            (x.occurrence_key ?? null) === (item.occurrence_key ?? null)
              ? { ...x, date: targetDate }
              : x
          )
        );
        void onRescheduleItem(item, targetDate);
      }
    } catch {
      // ignore invalid drag payload
    }
  }

  function handleOptimisticToggle(item: CalendarTaskItem) {
    setItems((prev) =>
      prev.map((x) =>
        x.task_id === item.task_id &&
        (x.occurrence_key ?? null) === (item.occurrence_key ?? null)
          ? { ...x, done: !x.done }
          : x
      )
    );
    void onToggleItem(item);
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      {/* Top Calendar Toolbar (Dida365 style) */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold text-slate-900">
            {year}年{monthNum}月
          </h1>
          <div className="flex items-center rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setMonth(addMonths(month, -1))}
              className="p-1 text-slate-600 hover:bg-slate-100 rounded-l-lg"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMonth(today.slice(0, 7))}
              className="border-x border-slate-200 px-2.5 py-0.5 text-xs text-slate-700 hover:bg-slate-100"
            >
              今天
            </button>
            <button
              type="button"
              onClick={() => setMonth(addMonths(month, 1))}
              className="p-1 text-slate-600 hover:bg-slate-100 rounded-r-lg"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <span className="ml-2 text-xs text-slate-400">
            拖动任务条可跨天改期 · 点击格子「+」快速新建
          </span>
        </div>

        <div className="flex items-center gap-2.5 text-xs">
          {lists.length > 0 && (
            <select
              value={listFilter}
              onChange={(e) => setListFilter(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-slate-600"
            >
              <option value="">全部清单</option>
              {lists.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={(e) => setIncludeCompleted(e.target.checked)}
              className="accent-blue-600"
            />
            显示已完成
          </label>
          <button
            type="button"
            onClick={() => !busy && void onSync()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin text-blue-500" : ""}`} />
            {busy ? "同步中" : "同步"}
          </button>
        </div>
      </div>

      {/* Weekday Header */}
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50/70 text-center text-xs font-medium text-slate-500">
        {weekdayHeaders(prefs.weekStart).map((w) => (
          <div key={w} className={`py-1.5 ${w === "周六" || w === "周日" ? "text-slate-400" : ""}`}>
            {w}
          </div>
        ))}
      </div>

      {/* 6x7 Month Grid */}
      <div className="grid flex-1 grid-cols-7 grid-rows-6 divide-x divide-y divide-slate-100 overflow-hidden">
        {cells.map((cell) => {
          const dayItems = byDate.get(cell.date) ?? [];
          const isToday = cell.date === today;
          const isDragOver = dragOverDate === cell.date;

          return (
            <div
              key={cell.date}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragOverDate !== cell.date) setDragOverDate(cell.date);
              }}
              onDragLeave={() => {
                if (dragOverDate === cell.date) setDragOverDate(null);
              }}
              onDrop={(e) => handleDrop(e, cell.date)}
              onDoubleClick={() => {
                setQuickAddDate(cell.date);
                setQuickTitle("");
              }}
              className={`group flex min-h-0 flex-col p-1.5 transition ${
                !cell.inMonth ? "bg-slate-50/60 text-slate-400" : "bg-white"
              } ${isDragOver ? "bg-blue-50/70 ring-2 ring-inset ring-blue-400" : ""}`}
            >
              {/* Day number + Lunar + Holiday badge + Quick add button */}
              <div className="mb-1 flex items-center justify-between gap-1">
                <div className="flex items-center gap-1 min-w-0">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                      isToday
                        ? "bg-blue-600 text-white"
                        : cell.weekend && cell.inMonth
                        ? "text-slate-500"
                        : "text-slate-700"
                    }`}
                  >
                    {cell.day}
                  </span>
                  <span
                    className={`truncate text-[10px] ${
                      cell.meta.isHighlight ? "text-blue-600 font-medium" : "text-slate-400"
                    }`}
                  >
                    {cell.meta.lunarText}
                  </span>
                  {cell.meta.holidayBadge && (
                    <span
                      className={`shrink-0 rounded px-1 text-[9px] font-medium ${
                        cell.meta.holidayBadge === "休"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {cell.meta.holidayBadge}
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  title={`在 ${cell.date} 新建任务`}
                  onClick={() => {
                    setQuickAddDate(cell.date);
                    setQuickTitle("");
                  }}
                  className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-slate-400 hover:bg-slate-200/70 hover:text-blue-600 transition"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Inline quick add on this date */}
              {quickAddDate === cell.date && (
                <input
                  autoFocus
                  value={quickTitle}
                  onChange={(e) => setQuickTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitQuickAdd(cell.date);
                    if (e.key === "Escape") setQuickAddDate(null);
                  }}
                  onBlur={() => void submitQuickAdd(cell.date)}
                  placeholder="任务标题，回车创建"
                  className="mb-1 w-full rounded border border-blue-400 bg-white px-1.5 py-0.5 text-[11px] outline-none shadow-xs"
                />
              )}

              {/* Task pills inside the day cell */}
              <div className="flex-1 space-y-1 overflow-y-auto pr-0.5">
                {dayItems.map((item) => {
                  const key = `${item.task_id}-${item.occurrence_key ?? "single"}`;
                  const isSelected = selectedTaskId === item.task_id;
                  return (
                    <div
                      key={key}
                      draggable
                      onDragStart={(e) => handleDragStart(e, item)}
                      onClick={() => onSelectTask(item.task_id)}
                      onContextMenu={(e) => {
                        if (!onContextMenuTask) return;
                        e.preventDefault();
                        onSelectTask(item.task_id);
                        onContextMenuTask(item.task_id, e.clientX, e.clientY);
                      }}
                      className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition ${
                        item.done
                          ? "border-slate-200 bg-slate-50 text-slate-400 line-through"
                          : PILL_COLOR[item.priority]
                      } ${isSelected ? "ring-1 ring-blue-500" : ""}`}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOptimisticToggle(item);
                        }}
                        className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-full border ${
                          item.done
                            ? "border-emerald-500 bg-emerald-500 text-white"
                            : "border-current opacity-60 hover:opacity-100"
                        }`}
                      >
                        {item.done && <Check className="h-2 w-2 stroke-[3]" />}
                      </button>
                      {item.time && (
                        <span className="shrink-0 opacity-75 text-[10px]">{formatTime(item.time, prefs.timeFormat)}</span>
                      )}
                      <span className="truncate flex-1">{item.title}</span>
                      {item.is_repeating && <Repeat className="h-2.5 w-2.5 shrink-0 opacity-70" />}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
