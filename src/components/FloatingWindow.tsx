import { listen } from "@tauri-apps/api/event";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Maximize2,
  PanelRightClose,
  RefreshCw,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CreateTaskInput, Task } from "../types";
import { isTaskOverdue } from "../utils/date";
import { QuickAddBar } from "./QuickAddBar";
import { TaskListItem } from "./TaskListItem";

type DockEdge = "left" | "right" | "top" | null;

/**
 * Layer 1: Frameless always-on-top floating quick window (`/?mode=floating`).
 * - Syncs in real time with MainWindow via `tasks:changed` and `tasks:synced`.
 * - Auto-folds into an edge bookmark tab when dragged close to left/right/top screen edge
 *   (or via the header fold button); click the bookmark to expand back.
 */
export function FloatingWindow() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [dockEdge, setDockEdge] = useState<DockEdge>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const list = await api.listTasks("today", undefined, "date");
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

  const overdue = tasks.filter(isTaskOverdue);
  const today = tasks.filter((t) => !isTaskOverdue(t));
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
        title="点击展开快捷悬浮窗"
        onClick={() => void api.undockFloatingWindow()}
        className={`group flex h-screen w-screen cursor-pointer items-center justify-center border border-blue-200 bg-white/95 text-slate-800 shadow-lg backdrop-blur transition hover:bg-blue-50 ${radiusClass} ${
          isTop ? "flex-row gap-2 px-3" : "flex-col gap-1.5 py-2"
        }`}
      >
        {isTop ? (
          <>
            <Sun className="h-3.5 w-3.5 text-amber-500" />
            <span className="text-xs font-semibold">今日 {totalCount}</span>
            {overdue.length > 0 && (
              <span className="h-2 w-2 rounded-full bg-red-500" title={`${overdue.length} 项逾期`} />
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
              今日待办
            </span>
            <span
              className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ${
                overdue.length > 0 ? "bg-red-500" : "bg-blue-600"
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
          className="flex flex-1 cursor-grab items-center gap-2 py-0.5 active:cursor-grabbing"
        >
          <span className="text-sm font-semibold">☀️ 今天</span>
          <span className="text-xs text-slate-400">
            {today.length} 项
            {overdue.length > 0 && (
              <span className="text-red-500"> · {overdue.length} 项逾期</span>
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

      <div className="flex-1 overflow-y-auto px-1">
        {overdue.length > 0 && (
          <>
            <div className="bg-red-50/60 px-2.5 py-1 text-[11px] font-semibold text-red-600">
              已逾期 · {overdue.length}
            </div>
            {overdue.map((t) => (
              <TaskListItem
                key={t.id}
                task={t}
                compact
                onSelect={(item) => void api.openMainWindow(item.id)}
                onToggle={(item) => void handleToggle(item)}
              />
            ))}
          </>
        )}

        <div className="px-2.5 py-1 text-[11px] font-semibold text-slate-400">今天</div>
        {today.length === 0 ? (
          <div className="p-4 text-center text-xs text-slate-400">今天没有待办 🎉</div>
        ) : (
          today.map((t) => (
            <TaskListItem
              key={t.id}
              task={t}
              compact
              onSelect={(item) => void api.openMainWindow(item.id)}
              onToggle={(item) => void handleToggle(item)}
            />
          ))
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
