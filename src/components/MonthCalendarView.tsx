import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Flag,
  PanelRight,
  Plus,
  RefreshCw,
  Repeat,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CalendarTaskItem, CreateTaskInput, Priority, UpdateTaskInput } from "../types";
import {
  addDays,
  addMonths,
  dateLabel,
  dueLabel,
  formatDate,
  listColorHex,
  nextMonday,
  parseDate,
  PRIORITY_META,
  todayStr,
} from "../utils/date";
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
  onQuickUpdateTask?: (taskId: number, patch: UpdateTaskInput) => Promise<void>;
  onContextMenuTask?: (taskId: number, x: number, y: number) => void;
  onSync: () => Promise<void>;
  busy?: boolean;
}

interface OverflowPopover {
  date: string;
  x: number;
  y: number;
}

interface QuickCardState {
  item: CalendarTaskItem;
  x: number;
  y: number;
}

const PRI_OPTIONS: Priority[] = ["urgent", "high", "low", "normal"];

export function MonthCalendarView({
  lists,
  selectedTaskId,
  refreshToken,
  onSelectTask,
  onCreateTaskOnDate,
  onRescheduleItem,
  onToggleItem,
  onQuickUpdateTask,
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
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [maxPills, setMaxPills] = useState(3);
  const [overflow, setOverflow] = useState<OverflowPopover | null>(null);
  const [quickCard, setQuickCard] = useState<QuickCardState | null>(null);
  const [cardTitle, setCardTitle] = useState("");

  const gridRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

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

  // Dynamically measure day cell height so pills never need inner scrollbars.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const rowH = el.clientHeight / 6;
      const cap = Math.max(2, Math.floor((rowH - 36) / 23));
      setMaxPills(cap);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Dismiss overflow or quick card popovers on outside click / Escape.
  useEffect(() => {
    if (!overflow && !quickCard) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) {
        if (quickCard) setQuickCard(null);
        return;
      }
      setQuickCard(null);
      setOverflow(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (quickCard) setQuickCard(null);
        else setOverflow(null);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [overflow, quickCard]);

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
    const key = `${item.task_id}-${item.occurrence_key ?? "single"}`;
    setDraggingKey(key);
    e.dataTransfer.setData("application/json", JSON.stringify(item));
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDrop(e: React.DragEvent, targetDate: string) {
    e.preventDefault();
    setDragOverDate(null);
    setDraggingKey(null);
    const raw = e.dataTransfer.getData("application/json");
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as CalendarTaskItem;
      if (item.date !== targetDate) {
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
    if (
      quickCard &&
      quickCard.item.task_id === item.task_id &&
      (quickCard.item.occurrence_key ?? null) === (item.occurrence_key ?? null)
    ) {
      setQuickCard({ ...quickCard, item: { ...quickCard.item, done: !quickCard.item.done } });
    }
    void onToggleItem(item);
  }

  function handlePillClick(e: React.MouseEvent, item: CalendarTaskItem) {
    e.stopPropagation();
    if (selectedTaskId !== null) {
      onSelectTask(item.task_id);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCardTitle(item.title);
    setQuickCard({ item, x: r.left, y: r.bottom + 6 });
  }

  function renderPill(item: CalendarTaskItem) {
    const key = `${item.task_id}-${item.occurrence_key ?? "single"}`;
    const isSelected = selectedTaskId === item.task_id;
    const isDragging = draggingKey === key;
    const priHex = PRIORITY_META[item.priority].hex;
    const accent = listColorHex(item.list) ?? priHex;

    return (
      <div
        key={key}
        draggable
        onDragStart={(e) => handleDragStart(e, item)}
        onDragEnd={() => {
          setDraggingKey(null);
          setDragOverDate(null);
        }}
        onClick={(e) => handlePillClick(e, item)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setQuickCard(null);
          onSelectTask(item.task_id);
        }}
        onContextMenu={(e) => {
          if (!onContextMenuTask) return;
          e.preventDefault();
          e.stopPropagation();
          setQuickCard(null);
          onSelectTask(item.task_id);
          onContextMenuTask(item.task_id, e.clientX, e.clientY);
        }}
        style={
          item.done
            ? { backgroundColor: "#F8FAFC", borderLeftColor: "#CBD5E1" }
            : {
                backgroundColor: isSelected ? `${accent}24` : `${accent}14`,
                borderLeftColor: accent,
              }
        }
        className={`flex h-[21px] cursor-pointer items-center gap-1 rounded-r-[5px] rounded-l-[2px] border-l-[3px] px-1.5 text-[11px] transition ${
          item.done ? "text-slate-400 line-through" : "text-slate-800 hover:brightness-95"
        } ${isSelected ? "ring-1 ring-blue-500" : ""} ${isDragging ? "opacity-40" : ""}`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleOptimisticToggle(item);
          }}
          style={item.done ? undefined : { borderColor: priHex }}
          className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border-[1.5px] transition ${
            item.done ? "border-slate-300 bg-slate-300 text-white" : "bg-white/80 hover:scale-110"
          }`}
        >
          {item.done && <Check className="h-2 w-2 stroke-[3]" />}
        </button>
        {item.time && (
          <span className="shrink-0 tabular-nums text-[10px] text-slate-500">
            {formatTime(item.time, prefs.timeFormat)}
          </span>
        )}
        <span className="flex-1 truncate">{item.title}</span>
        {item.is_repeating && <Repeat className="h-2.5 w-2.5 shrink-0 text-slate-400" />}
      </div>
    );
  }

  const overflowItems = overflow ? byDate.get(overflow.date) ?? [] : [];
  const overflowMeta = overflow ? getDayCalendarMeta(overflow.date) : null;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      {/* Top Calendar Toolbar (Dida365 style) */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            {year}年{monthNum}月
          </h1>
          <div className="flex items-center rounded-lg border border-slate-200 bg-white">
            <button
              type="button"
              title="上个月"
              onClick={() => setMonth(addMonths(month, -1))}
              className="rounded-l-lg p-1 text-slate-600 hover:bg-slate-100"
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
              title="下个月"
              onClick={() => setMonth(addMonths(month, 1))}
              className="rounded-r-lg p-1 text-slate-600 hover:bg-slate-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <span className="hidden lg:inline text-xs text-slate-400">
            拖动改期 · 单击快编 · 双击格新建
          </span>
        </div>

        <div className="flex items-center gap-2.5 text-xs">
          {lists.length > 0 && (
            <select
              value={listFilter}
              onChange={(e) => setListFilter(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 outline-none focus:border-blue-400"
            >
              <option value="">全部清单</option>
              {lists.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
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
      <div
        ref={gridRef}
        className="grid flex-1 grid-cols-7 grid-rows-6 divide-x divide-y divide-slate-100 overflow-hidden"
      >
        {cells.map((cell) => {
          const dayItems = byDate.get(cell.date) ?? [];
          const isToday = cell.date === today;
          const isDragOver = dragOverDate === cell.date;
          const isRestDay =
            cell.meta.holidayBadge === "休" || (cell.weekend && cell.meta.holidayBadge !== "班");
          const hasOverflow = dayItems.length > maxPills;
          const visibleItems = hasOverflow ? dayItems.slice(0, maxPills - 1) : dayItems;
          const hiddenCount = dayItems.length - visibleItems.length;

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
                !cell.inMonth
                  ? "bg-slate-50/80 opacity-55"
                  : isRestDay
                  ? "bg-slate-50/45"
                  : "bg-white"
              } ${isDragOver ? "!bg-blue-50/90 !opacity-100 ring-2 ring-inset ring-blue-500" : ""}`}
            >
              {/* Day number + Lunar + Holiday badge + Quick add button */}
              <div className="mb-1 flex items-center justify-between gap-1">
                <div className="flex min-w-0 items-center gap-1">
                  <span
                    className={`flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full text-xs ${
                      isToday
                        ? "bg-blue-600 font-semibold text-white shadow-2xs"
                        : isRestDay && cell.inMonth
                        ? "font-medium text-slate-400"
                        : "font-medium text-slate-700"
                    }`}
                  >
                    {cell.day}
                  </span>
                  <span
                    className={`truncate text-[10px] ${
                      cell.meta.isHighlight ? "font-medium text-blue-600" : "text-slate-400"
                    }`}
                  >
                    {cell.meta.lunarText}
                  </span>
                  {cell.meta.holidayBadge && (
                    <span
                      className={`shrink-0 rounded px-1 text-[9px] font-medium ${
                        cell.meta.holidayBadge === "休"
                          ? "bg-emerald-50 text-emerald-600"
                          : "bg-amber-50 text-amber-700"
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
                  className="rounded p-0.5 text-slate-400 opacity-0 transition hover:bg-slate-200/70 hover:text-blue-600 group-hover:opacity-100"
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
                  className="mb-1 w-full rounded border border-blue-400 bg-white px-1.5 py-0.5 text-[11px] shadow-xs outline-none"
                />
              )}

              {/* Clamped task pills + "+N 更多" trigger */}
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
                {visibleItems.map(renderPill)}
                {hasOverflow && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      setOverflow({ date: cell.date, x: r.left, y: r.top - 10 });
                    }}
                    className="mt-auto rounded px-1.5 py-0.5 text-left text-[10.5px] font-medium text-slate-500 transition hover:bg-blue-50 hover:text-blue-600"
                  >
                    +{hiddenCount} 更多
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Day "+N 更多" Overflow Popover */}
      {overflow && (
        <div
          ref={popoverRef}
          style={{
            left: Math.max(12, Math.min(overflow.x, window.innerWidth - 272)),
            top: Math.max(12, Math.min(overflow.y, window.innerHeight - 320)),
          }}
          className="fixed z-40 flex max-h-72 w-64 flex-col rounded-2xl border border-slate-200 bg-white p-3 shadow-xl animate-pop-in"
        >
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-slate-800">{dateLabel(overflow.date)}</div>
              <div className="text-[10px] text-slate-400">
                {overflowMeta?.lunarText} · 共 {overflowItems.length} 项
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="在此日新建"
                onClick={() => {
                  const d = overflow.date;
                  setOverflow(null);
                  setQuickAddDate(d);
                  setQuickTitle("");
                }}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setOverflow(null)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto pr-0.5">
            {overflowItems.map(renderPill)}
          </div>
        </div>
      )}

      {/* Pill Quick Card Popover */}
      {quickCard && (
        <div
          ref={cardRef}
          style={{
            left: Math.max(12, Math.min(quickCard.x, window.innerWidth - 292)),
            top: Math.max(12, Math.min(quickCard.y, window.innerHeight - 220)),
          }}
          className="fixed z-50 w-70 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xl space-y-3 animate-pop-in"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleOptimisticToggle(quickCard.item)}
              style={
                quickCard.item.done
                  ? undefined
                  : { borderColor: PRIORITY_META[quickCard.item.priority].hex }
              }
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] ${
                quickCard.item.done ? "border-slate-300 bg-slate-300 text-white" : "hover:bg-slate-50"
              }`}
            >
              {quickCard.item.done && <Check className="h-3 w-3 stroke-[3]" />}
            </button>

            {quickCard.item.list && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: listColorHex(quickCard.item.list) ?? "#4772FA" }}
                />
                {quickCard.item.list}
              </span>
            )}

            <button
              type="button"
              onClick={() => setQuickCard(null)}
              className="ml-auto rounded-md p-0.5 text-slate-400 hover:bg-slate-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <input
            value={cardTitle}
            onChange={(e) => setCardTitle(e.target.value)}
            onBlur={() => {
              const trimmed = cardTitle.trim();
              if (trimmed && trimmed !== quickCard.item.title && onQuickUpdateTask) {
                void onQuickUpdateTask(quickCard.item.task_id, { title: trimmed });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className={`w-full bg-transparent text-sm font-semibold outline-none ${
              quickCard.item.done ? "line-through text-slate-400" : "text-slate-900"
            }`}
          />

          <div className="flex flex-wrap items-center gap-1 text-[11px]">
            <Calendar className="h-3.5 w-3.5 text-slate-400" />
            <span className="mr-1 font-medium text-slate-700">
              {dueLabel(quickCard.item.date)}
              {quickCard.item.time ? ` ${formatTime(quickCard.item.time, prefs.timeFormat)}` : ""}
            </span>
            {(
              [
                [today, "今天"],
                [addDays(today, 1), "明天"],
                [nextMonday(), "下周一"],
              ] as const
            ).map(([d, lbl]) => (
              <button
                key={lbl}
                type="button"
                onClick={() => {
                  if (quickCard.item.date !== d) {
                    setItems((prev) =>
                      prev.map((x) =>
                        x.task_id === quickCard.item.task_id &&
                        (x.occurrence_key ?? null) === (quickCard.item.occurrence_key ?? null)
                          ? { ...x, date: d }
                          : x
                      )
                    );
                    void onRescheduleItem(quickCard.item, d);
                    setQuickCard({ ...quickCard, item: { ...quickCard.item, date: d } });
                  }
                }}
                className={`rounded px-1.5 py-0.5 ${
                  quickCard.item.date === d
                    ? "bg-blue-50 font-medium text-blue-600"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 pt-2">
            <div className="flex items-center gap-1">
              {PRI_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  title={`${PRIORITY_META[p].label}优先级`}
                  onClick={() => {
                    if (!onQuickUpdateTask) return;
                    setItems((prev) =>
                      prev.map((x) =>
                        x.task_id === quickCard.item.task_id ? { ...x, priority: p } : x
                      )
                    );
                    setQuickCard({ ...quickCard, item: { ...quickCard.item, priority: p } });
                    void onQuickUpdateTask(quickCard.item.task_id, { priority: p });
                  }}
                  className={`rounded-md p-1 ${
                    quickCard.item.priority === p ? "bg-slate-100 ring-1 ring-slate-300" : "hover:bg-slate-100"
                  }`}
                >
                  <Flag className="h-3.5 w-3.5" style={{ color: PRIORITY_META[p].hex }} />
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                const id = quickCard.item.task_id;
                setQuickCard(null);
                onSelectTask(id);
              }}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100"
            >
              <PanelRight className="h-3.5 w-3.5" />
              展开详情
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
