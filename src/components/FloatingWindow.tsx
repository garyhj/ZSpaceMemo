import { listen } from "@tauri-apps/api/event";
import {
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  PanelRightClose,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CreateTaskInput, Task } from "../types";
import { addDays, effectiveDue, isTaskOverdue, parseDate, todayStr } from "../utils/date";
import { usePrefs } from "../utils/prefs";
import { QuickAddBar } from "./QuickAddBar";
import { TaskListItem } from "./TaskListItem";

type DockEdge = "left" | "right" | "top" | null;
type GroupKey = "overdue" | "today" | "week" | "later" | "unscheduled";

/**
 * Layer 1: Frameless always-on-top floating quick window (`/?mode=floating`).
 * - Shows ALL active tasks grouped by 已逾期 / 今天 / 本周 / 以后 / 无日期.
 * - Syncs in real time with MainWindow via `tasks:changed` and `tasks:synced`.
 * - Auto-folds into an edge bookmark tab when dragged close to left/right/top screen edge
 *   (or via the header fold button); click the bookmark to expand back.
 */
export function FloatingWindow() {
  const prefs = usePrefs();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [dockEdge, setDockEdge] = useState<DockEdge>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<GroupKey, boolean>>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const list = await api.listTasks("all", undefined, "date");
      setTasks(list);
    } catch {
      // Ignore if not logged in yet.
    }
  }

  useEffect(() => {
    // Transparent root so rounded card / edge bookmark tab render cleanly without corners.
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
    const unlistenDock = listen<DockEdge>("floating:dock-changed", (ev) => {
      setDockEdge(ev.payload ?? null);
    });
    const onWinFocus = () => void refresh();
    window.addEventListener("focus", onWinFocus);

    return () => {
      window.removeEventListener("focus", onWinFocus);
      void unlistenFocus.then((f) => f());
      void unlistenSync.then((f) => f());
      void unlistenChanged.then((f) => f());
      void unlistenDock.then((f) => f());
    };
  }, []);

  async function handleCreate(input: CreateTaskInput) {
    await api.createTask(input);
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

  const { groups, overdueCount } = useMemo(() => {
    const today = todayStr();
    const dow = parseDate(today).getDay(); // 0=Sun..6=Sat
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

  // Compact edge-docked bookmark tab
  if (dockEdge) {
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
        title="点击展开待办悬浮窗"
        onClick={() => void api.undockFloatingWindow()}
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
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xl">
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2 select-none">
        <div
          data-tauri-drag-region="deep"
          title="按住拖动位置；拖到屏幕左 / 右 / 上边缘可自动收起为书签"
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
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="贴边收起为书签"
            onClick={() => void api.dockFloatingWindow()}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
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
            title="隐藏悬浮窗 (Ctrl/Cmd+Shift+M)"
            onClick={() => void api.toggleFloatingWindow()}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="border-b border-slate-100 p-2">
        <QuickAddBar compact inputRef={inputRef} busy={busy} onCreate={handleCreate} />
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-2">
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
                    />
                  ))}
              </div>
            );
          })
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400 select-none">
        <span data-tauri-drag-region="deep" className="flex-1 cursor-grab active:cursor-grabbing">
          拖到屏幕边可收起为书签
        </span>
        <button
          type="button"
          onClick={() => void api.openMainWindow()}
          className="text-blue-600 hover:underline"
        >
          打开主界面 ›
        </button>
      </footer>
    </div>
  );
}
