import { listen } from "@tauri-apps/api/event";
import { Maximize2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CreateTaskInput, Task } from "../types";
import { isTaskOverdue } from "../utils/date";
import { QuickAddBar } from "./QuickAddBar";
import { TaskListItem } from "./TaskListItem";

/**
 * Layer 1: Lightweight always-on-top floating quick window (`/?mode=floating`).
 * Shows Today + Overdue tasks, quick-add bar, one-click complete, and jumps to Main Window for full editing.
 */
export function FloatingWindow() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
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
    void refresh();
    const unlistenFocus = listen("floating:focus-input", () => {
      inputRef.current?.focus();
    });
    const unlistenSync = listen("tasks:synced", () => {
      void refresh();
    });
    return () => {
      void unlistenFocus.then((f) => f());
      void unlistenSync.then((f) => f());
    };
  }, []);

  async function handleCreate(input: CreateTaskInput) {
    setBusy(true);
    try {
      await api.createTask(input);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(task: Task) {
    setBusy(true);
    try {
      await api.completeTask(task.id);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const overdue = tasks.filter(isTaskOverdue);
  const today = tasks.filter((t) => !isTaskOverdue(t));

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">☀️ 今天</span>
          <span className="text-xs text-slate-400">
            {today.length} 项
            {overdue.length > 0 && <span className="text-red-500"> · {overdue.length} 项逾期</span>}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="立即同步"
            onClick={() => void api.syncTasks().then(refresh)}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="打开主界面"
            onClick={() => void api.openMainWindow()}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="border-b border-slate-100 p-2">
        <QuickAddBar compact inputRef={inputRef} busy={busy} onCreate={handleCreate} />
      </div>

      <div className="flex-1 overflow-y-auto">
        {overdue.length > 0 && (
          <>
            <div className="bg-red-50/60 px-3 py-1 text-[11px] font-semibold text-red-600">
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

        <div className="px-3 py-1 text-[11px] font-semibold text-slate-400">今天</div>
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

      <footer className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400">
        <span>点任务在主界面编辑</span>
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
