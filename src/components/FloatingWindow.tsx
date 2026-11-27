import { listen } from "@tauri-apps/api/event";
import {
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  PanelRightClose,
  Pin,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CreateTaskInput, Priority, Task } from "../types";
import { addDays, effectiveDue, isTaskOverdue, parseDate, todayStr } from "../utils/date";
import { usePrefs } from "../utils/prefs";
import { confirmAction } from "./ConfirmDialog";
import { QuickAddBar } from "./QuickAddBar";
import { TaskContextMenu, type ContextMenuState } from "./TaskContextMenu";
import { TaskListItem } from "./TaskListItem";

type DockEdge = "left" | "right" | "top" | null;
type DockEventPayload = DockEdge | { edge?: DockEdge; peeked?: boolean } | null;
type GroupKey = "overdue" | "today" | "week" | "later" | "unscheduled";

/**
 * Layer 1: Frameless always-on-top floating quick window (`/?mode=floating`).
 * - Shows ALL active tasks grouped by 已逾期 / 今天 / 本周 / 以后 / 无日期.
 * - Edge dock behavior:
 *   - Hovering over the docked bookmark tab peeks open flush at the edge; leaving folds it back.
 *   - Clicking the docked bookmark tab (or clicking "固定移开" while peeking) undocks and moves it away from the edge.
 */
export function FloatingWindow() {
  const prefs = usePrefs();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [globalShortcut, setGlobalShortcut] = useState("CommandOrControl+Shift+M");
  const [busy, setBusy] = useState(false);
  const [dockEdge, setDockEdge] = useState<DockEdge>(null);
  const [dockPeeked, setDockPeeked] = useState(false);
  const [collapsed, setCollapsed] = useState<Partial<Record<GroupKey, boolean>>>({});
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const dockStateRef = useRef<{ edge: DockEdge; peeked: boolean }>({ edge: null, peeked: false });
  const hoveringRef = useRef(false);
  const inputFocusedRef = useRef(false);
  const ctxOpenRef = useRef(false);
  const peekTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);

  dockStateRef.current = { edge: dockEdge, peeked: dockPeeked };
  ctxOpenRef.current = Boolean(ctxMenu);
  inputFocusedRef.current = inputFocused;

  useEffect(() => {
    if (dockEdge && dockPeeked) {
      void api.setFloatingPeekHold(Boolean(ctxMenu) || inputFocused).catch(() => {});
    }
  }, [dockEdge, dockPeeked, ctxMenu, inputFocused]);

  function clearPeekTimer() {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
  }

  function clearCollapseTimer() {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }

  function scheduleCollapseIfPeeked() {
    clearCollapseTimer();
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      const st = dockStateRef.current;
      if (!st.edge || !st.peeked) return;
      if (hoveringRef.current || ctxOpenRef.current || inputFocusedRef.current) return;
      void api.collapsePeekFloatingWindow();
    }, 220);
  }

  async function refresh() {
    try {
      const [list, cfg] = await Promise.all([
        api.listTasks("all", undefined, "date"),
        api.getSettings().catch(() => null),
      ]);
      setTasks(list);
      if (cfg?.global_shortcut) {
        setGlobalShortcut(cfg.global_shortcut);
      }
    } catch {
      // Ignore if not logged in yet.
    }
  }

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";

    void refresh();
    const unlistenFocus = listen("floating:focus-input", () => {
      void refresh();
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    const unlistenSync = listen("tasks:synced", () => {
      void refresh();
    });
    const unlistenChanged = listen<string>("tasks:changed", (ev) => {
      if (ev.payload !== "floating") void refresh();
    });
    const unlistenDock = listen<DockEventPayload>("floating:dock-changed", (ev) => {
      const p = ev.payload;
      if (p && typeof p === "object") {
        setDockEdge(p.edge ?? null);
        setDockPeeked(Boolean(p.peeked));
      } else {
        setDockEdge((p as DockEdge) ?? null);
        setDockPeeked(false);
      }
      hoveringRef.current = false;
      setInputFocused(false);
      clearPeekTimer();
      clearCollapseTimer();
    });
    const onWinFocus = () => void refresh();
    window.addEventListener("focus", onWinFocus);

    return () => {
      clearPeekTimer();
      clearCollapseTimer();
      window.removeEventListener("focus", onWinFocus);
      void unlistenFocus.then((f) => f());
      void unlistenSync.then((f) => f());
      void unlistenChanged.then((f) => f());
      void unlistenDock.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!ctxMenu) {
      scheduleCollapseIfPeeked();
    }
  }, [ctxMenu]);

  async function handleCreate(input: CreateTaskInput) {
    let enriched = input;
    if (input.schedule?.due && (!input.reminders || input.reminders.length === 0)) {
      const cfg = await api.getSettings().catch(() => null);
      if (!cfg || cfg.default_auto_remind) {
        const isTimed = !input.schedule.all_day && Boolean(input.schedule.due.time);
        enriched = {
          ...input,
          reminders: [
            isTimed
              ? { type: "relative", id: "auto_due", offset_minutes: 0 }
              : {
                  type: "relative",
                  id: "auto_day",
                  offset_days: 0,
                  day_time: cfg?.default_all_day_reminder_time ?? "09:00",
                },
          ],
        };
      }
    }
    await api.createTask(enriched);
    await refresh();
  }

  async function handleToggle(task: Task) {
    const prev = tasks;
    const done = task.status === "completed" || task.status === "ended";
    if (!task.repeat) {
      setTasks((cur) => cur.filter((t) => t.id !== task.id));
    }
    try {
      if (done) await api.reopenTask(task.id);
      else await api.completeTask(task.id);
      await refresh();
    } catch {
      setTasks(prev);
    }
  }

  async function handlePatch(task: Task, patch: Parameters<typeof api.updateTask>[1]) {
    const prev = tasks;
    setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, ...patch } : t)));
    try {
      await api.updateTask(task.id, { ...patch, etag: task.etag });
      await refresh();
    } catch {
      setTasks(prev);
    }
  }

  async function handleSetDate(task: Task, d: string | null) {
    if (task.repeat && task.series) {
      if (!d) return;
      const key = task.effective_current_key ?? task.series.cursor;
      const allDay = task.schedule.all_day || !task.schedule.due?.time;
      const dueTime = allDay ? null : task.schedule.due?.time ?? null;
      try {
        await api.overrideOccurrence(task.id, key, d, dueTime, allDay, null);
        await refresh();
      } catch {
        // leave tasks unchanged on failure
      }
      return;
    }
    await handlePatch(task, {
      schedule: {
        ...task.schedule,
        all_day: d ? task.schedule.all_day || !task.schedule.due?.time : false,
        due: d ? { date: d, time: task.schedule.all_day ? null : task.schedule.due?.time ?? null } : null,
      },
    });
  }

  async function handleDelete(task: Task) {
    if (
      !(await confirmAction({
        title: "删除任务",
        message: `确定删除「${task.title}」吗？`,
        confirmText: "删除",
        danger: true,
      }))
    ) {
      return;
    }
    const prev = tasks;
    setTasks((cur) => cur.filter((t) => t.id !== task.id));
    try {
      await api.deleteTask(task.id);
      await refresh();
    } catch {
      setTasks(prev);
    }
  }

  const lists = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.list) set.add(t.list);
    return Array.from(set).sort();
  }, [tasks]);

  const { groups, overdueCount } = useMemo(() => {
    const today = todayStr();
    const dow = parseDate(today).getDay();
    const daysToEnd = prefs.weekStart === "mon" ? (7 - dow) % 7 : 6 - dow;
    const weekEnd = addDays(today, daysToEnd);

    const overdue: Task[] = [];
    const todayList: Task[] = [];
    const week: Task[] = [];
    const later: Task[] = [];
    const unscheduled: Task[] = [];

    for (const t of tasks) {
      const due = effectiveDue(t);
      if (isTaskOverdue(t)) {
        overdue.push(t);
      } else if (!due) {
        unscheduled.push(t);
      } else if (due.date <= today) {
        todayList.push(t);
      } else if (due.date <= weekEnd) {
        week.push(t);
      } else {
        later.push(t);
      }
    }

    const list: { key: GroupKey; label: string; tone: "danger" | "primary" | "default"; items: Task[] }[] = [
      { key: "overdue", label: "已逾期", tone: "danger", items: overdue },
      { key: "today", label: "今天", tone: "primary", items: todayList },
      { key: "week", label: "本周", tone: "default", items: week },
      { key: "later", label: "以后", tone: "default", items: later },
      { key: "unscheduled", label: "无日期", tone: "default", items: unscheduled },
    ];
    return { groups: list.filter((g) => g.items.length > 0), overdueCount: overdue.length };
  }, [tasks, prefs.weekStart]);

  const totalCount = tasks.length;

  // Compact edge-docked bookmark tab (collapsed state)
  if (dockEdge && !dockPeeked) {
    const isTop = dockEdge === "top";
    const radiusClass =
      dockEdge === "left"
        ? "rounded-r-2xl border-l-0"
        : dockEdge === "right"
        ? "rounded-l-2xl border-r-0"
        : "rounded-b-2xl border-t-0";

    return (
      <button
        type="button"
        title="鼠标指向贴边展开，移开自动折叠；展开后拖出边缘或点「移开固定」可常驻"
        onMouseEnter={() => {
          hoveringRef.current = true;
          clearPeekTimer();
          peekTimerRef.current = window.setTimeout(() => {
            peekTimerRef.current = null;
            if (hoveringRef.current && dockStateRef.current.edge && !dockStateRef.current.peeked) {
              void api.peekFloatingWindow();
            }
          }, 100);
        }}
        onMouseLeave={() => {
          hoveringRef.current = false;
          clearPeekTimer();
        }}
        onClick={() => {
          clearPeekTimer();
          void api.peekFloatingWindow();
        }}
        className={`group flex h-screen w-screen cursor-pointer items-center justify-center border border-blue-200 bg-white/95 text-slate-800 shadow-lg backdrop-blur transition hover:bg-blue-50 ${radiusClass} ${
          isTop ? "flex-row gap-2 px-3" : "flex-col gap-1.5 py-2"
        }`}
      >
        {isTop ? (
          <>
            <CheckSquare className="h-3.5 w-3.5 text-blue-600" />
            <span className="text-xs font-semibold">待办 {totalCount}</span>
            {overdueCount > 0 && (
              <span className="h-2 w-2 rounded-full bg-red-500" title={`${overdueCount} 项逾期`} />
            )}
            <ChevronDown className="h-3.5 w-3.5 text-blue-600 transition group-hover:translate-y-0.5" />
          </>
        ) : (
          <>
            {dockEdge === "left" ? (
              <ChevronRight className="h-3.5 w-3.5 text-blue-600 transition group-hover:translate-x-0.5" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5 text-blue-600 transition group-hover:-translate-x-0.5" />
            )}
            <span className="text-[11px] font-semibold leading-tight tracking-widest [writing-mode:vertical-rl]">
              待办
            </span>
            <span
              className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ${
                overdueCount > 0 ? "bg-red-500" : "bg-blue-600"
              }`}
            >
              {totalCount}
            </span>
          </>
        )}
      </button>
    );
  }

  return (
    <div
      onMouseEnter={() => {
        hoveringRef.current = true;
        clearCollapseTimer();
      }}
      onMouseLeave={() => {
        hoveringRef.current = false;
        scheduleCollapseIfPeeked();
      }}
      className={`flex h-screen w-screen flex-col overflow-hidden rounded-2xl border bg-white shadow-xl ${
        dockPeeked ? "border-blue-300 ring-1 ring-blue-200/70" : "border-slate-200/90"
      }`}
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2 select-none">
        <div
          data-tauri-drag-region="deep"
          title={
            dockPeeked
              ? "悬停展开中：移出鼠标自动折叠；拖动或点右侧「固定移开」可常驻展开"
              : "按住拖动位置；拖到屏幕左 / 右 / 上边缘可自动收起为书签"
          }
          className="flex flex-1 cursor-grab items-center gap-1.5 py-0.5 active:cursor-grabbing"
        >
          <CheckSquare className="h-4 w-4 text-blue-600" />
          <span className="text-sm font-semibold text-slate-900">待办</span>
          <span className="text-xs text-slate-400">
            {totalCount} 项
            {overdueCount > 0 && (
              <span className="text-red-500"> · {overdueCount} 逾期</span>
            )}
          </span>
          {dockPeeked && (
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
              悬停展开
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {dockPeeked ? (
            <button
              type="button"
              title="移开边缘并固定展开"
              onClick={() => void api.undockFloatingWindow()}
              className="inline-flex items-center gap-0.5 rounded-lg bg-blue-50 px-1.5 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-100"
            >
              <Pin className="h-3 w-3" />
              移开固定
            </button>
          ) : (
            <button
              type="button"
              title="贴边收起为书签"
              onClick={() => void api.dockFloatingWindow()}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            title="立即同步"
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void api
                .syncTasks()
                .then(refresh)
                .finally(() => setBusy(false));
            }}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin text-blue-500" : ""}`} />
          </button>
          <button
            type="button"
            title="打开主界面"
            onClick={() => void api.openMainWindow()}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={dockPeeked ? "立即折叠回贴边书签" : `隐藏悬浮窗 (${globalShortcut})`}
            onClick={() =>
              void (dockPeeked ? api.collapsePeekFloatingWindow() : api.toggleFloatingWindow())
            }
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div
        className="border-b border-slate-100 p-2"
        onFocusCapture={() => {
          setInputFocused(true);
          clearCollapseTimer();
        }}
        onBlurCapture={() => {
          window.setTimeout(() => {
            const active = document.activeElement;
            const stillInsideInput = Boolean(
              active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
            );
            setInputFocused(stillInsideInput);
            if (!stillInsideInput) scheduleCollapseIfPeeked();
          }, 30);
        }}
      >
        <QuickAddBar compact inputRef={inputRef} busy={busy} onCreate={handleCreate} />
      </div>

      <div className="flex-1 overscroll-contain overflow-y-auto px-1 pb-2">
        {groups.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">暂无待办 🎉</div>
        ) : (
          groups.map((g) => {
            const isCollapsed = Boolean(collapsed[g.key]);
            const headerColor =
              g.tone === "danger"
                ? "text-red-500 bg-red-50/70"
                : g.tone === "primary"
                ? "text-blue-600 bg-white/95"
                : "text-slate-500 bg-white/95";

            return (
              <div key={g.key}>
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
                  className={`sticky top-0 z-10 flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-semibold backdrop-blur ${headerColor}`}
                >
                  <ChevronRight
                    className={`h-3 w-3 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  />
                  <span>{g.label}</span>
                  <span className="font-normal opacity-75">{g.items.length}</span>
                </button>
                {!isCollapsed &&
                  g.items.map((t) => (
                    <TaskListItem
                      key={t.id}
                      task={t}
                      compact
                      onSelect={(item) => void api.openMainWindow(item.id)}
                      onToggle={(item) => void handleToggle(item)}
                      onOpenMenu={(task, x, y, mode = "full") =>
                        setCtxMenu({ task, x, y, mode })
                      }
                    />
                  ))}
              </div>
            );
          })
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400 select-none">
        <span data-tauri-drag-region="deep" className="flex-1 cursor-grab active:cursor-grabbing">
          {dockPeeked ? "鼠标移开自动折叠 · 拖动/点「移开固定」常驻" : "右键可改期/优先级 · 拖到屏幕边收起"}
        </span>
        <button
          type="button"
          onClick={() => void api.openMainWindow()}
          className="text-blue-600 hover:underline"
        >
          打开主界面 ›
        </button>
      </footer>

      {ctxMenu && (
        <TaskContextMenu
          menu={ctxMenu}
          lists={lists}
          onClose={() => setCtxMenu(null)}
          onSetDate={(t, d) => void handleSetDate(t, d)}
          onSetPriority={(t, p: Priority) => void handlePatch(t, { priority: p })}
          onTogglePin={(t) => void handlePatch(t, { pinned: !t.pinned })}
          onToggleDone={(t) => void handleToggle(t)}
          onMoveToList={(t, l) => void handlePatch(t, { list: l })}
          onCopyTitle={(t) => void navigator.clipboard?.writeText(t.title)}
          onDelete={(t) => void handleDelete(t)}
        />
      )}
    </div>
  );
}
