import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  Bell,
  Calendar,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  Inbox,
  Layers,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { AuthScreen } from "./components/AuthScreen";
import { FloatingWindow } from "./components/FloatingWindow";
import { MonthCalendarView } from "./components/MonthCalendarView";
import { NotificationDrawer } from "./components/NotificationDrawer";
import { QuickAddBar } from "./components/QuickAddBar";
import { SettingsModal } from "./components/SettingsModal";
import { TaskDetail } from "./components/TaskDetail";
import { TaskListItem } from "./components/TaskListItem";
import type {
  AppSettings,
  AuthStatus,
  CalendarTaskItem,
  CreateTaskInput,
  NotificationRecord,
  Task,
  TaskSort,
  TaskView,
  UpdateTaskInput,
} from "./types";
import { dateLabel, effectiveDue, isTaskOverdue, todayStr } from "./utils/date";

const VIEW_ITEMS: { key: TaskView; label: string; icon: React.ReactNode }[] = [
  { key: "today", label: "今天", icon: <Sun className="h-4 w-4" /> },
  { key: "upcoming", label: "即将到来", icon: <CalendarClock className="h-4 w-4" /> },
  { key: "inbox", label: "收集箱", icon: <Inbox className="h-4 w-4" /> },
  { key: "overdue", label: "已逾期", icon: <AlertCircle className="h-4 w-4" /> },
  { key: "repeating", label: "重复任务", icon: <Repeat className="h-4 w-4" /> },
  { key: "all", label: "全部任务", icon: <Layers className="h-4 w-4" /> },
  { key: "completed", label: "已完成", icon: <CheckCircle2 className="h-4 w-4" /> },
];

const LIST_DOT_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-cyan-500",
];

function listDotColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return LIST_DOT_COLORS[h % LIST_DOT_COLORS.length];
}

interface ToastState {
  message: string;
  undoLabel?: string;
  onUndo?: () => Promise<void>;
}

export default function App() {
  const isFloating = useMemo(
    () => new URLSearchParams(window.location.search).get("mode") === "floating",
    []
  );

  if (isFloating) {
    return <FloatingWindow />;
  }

  return <MainWindow />;
}

function MainWindow() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Dida365 top-level workspace switcher: Tasks vs Month Calendar
  const [workspace, setWorkspace] = useState<"tasks" | "calendar">("tasks");
  const [view, setView] = useState<TaskView>("today");
  const [activeList, setActiveList] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [customLists, setCustomLists] = useState<string[]>([]);
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState("");

  const [sort, setSort] = useState<TaskSort>("date");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [allActive, setAllActive] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [calendarRefreshToken, setCalendarRefreshToken] = useState(0);

  const lastFocusSyncRef = useRef<number>(0);

  const selected = useMemo(
    () =>
      tasks.find((t) => t.id === selectedId) ??
      allActive.find((t) => t.id === selectedId) ??
      null,
    [tasks, allActive, selectedId]
  );

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const lists = useMemo(() => {
    const set = new Set<string>(customLists);
    for (const t of allActive) {
      if (t.list) set.add(t.list);
    }
    return Array.from(set).sort();
  }, [allActive, customLists]);

  // Sidebar live counts
  const viewCounts = useMemo(() => {
    const today = todayStr();
    let inbox = 0;
    let todayCount = 0;
    let overdue = 0;
    let repeating = 0;
    for (const t of allActive) {
      if (t.repeat) repeating++;
      const due = effectiveDue(t);
      const od = isTaskOverdue(t);
      if (od) overdue++;
      if (!t.repeat && !due) inbox++;
      if (due?.date === today || (settings?.show_overdue_in_today !== false && od)) {
        todayCount++;
      }
    }
    return {
      inbox,
      today: todayCount,
      overdue,
      repeating,
      all: allActive.length,
    };
  }, [allActive, settings?.show_overdue_in_today]);

  const listCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of allActive) {
      if (t.list) m[t.list] = (m[t.list] ?? 0) + 1;
    }
    return m;
  }, [allActive]);

  const { allLabels, labelCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of allActive) {
      for (const lb of t.labels) {
        counts[lb] = (counts[lb] ?? 0) + 1;
      }
    }
    return { allLabels: Object.keys(counts).sort(), labelCounts: counts };
  }, [allActive]);

  function showToast(message: string, onUndo?: () => Promise<void>) {
    const next: ToastState = { message, undoLabel: onUndo ? "撤销" : undefined, onUndo };
    setToast(next);
    window.setTimeout(() => {
      setToast((cur) => (cur === next ? null : cur));
    }, 5000);
  }

  async function refreshAll(v = view, q = query, s = sort) {
    try {
      const [list, active, notifs] = await Promise.all([
        api.listTasks(v, q, s),
        api.listTasks("all", undefined, "date"),
        api.listNotifications(50),
      ]);
      setTasks(list);
      setAllActive(active);
      setNotifications(notifs);
      setCalendarRefreshToken((n) => n + 1);
    } catch (e) {
      showToast(`刷新列表失败：${String(e)}`);
    }
  }

  async function bootstrap(st: AuthStatus) {
    setAuth(st);
    if (!st.logged_in) return;
    try {
      const cfg = await api.getSettings();
      setSettings(cfg);
      await api.initializeCategory(true);
      await api.syncTasks();
      await refreshAll();
    } catch (e) {
      showToast(`初始化失败：${String(e)}`);
    }
  }

  useEffect(() => {
    api
      .authStatus()
      .then((st) => bootstrap(st))
      .catch(() => setAuth({ logged_in: false, profile: "zspace-memo" }))
      .finally(() => setAuthChecked(true));

    const unSynced = listen("tasks:synced", () => {
      void refreshAll();
    });
    const unFired = listen("reminder:fired", () => {
      void api.listNotifications(50).then(setNotifications);
    });
    const unSelect = listen<number>("task:select", (ev) => {
      setWorkspace("tasks");
      setSelectedId(ev.payload);
      setView("all");
      setActiveList(null);
    });

    return () => {
      void unSynced.then((f) => f());
      void unFired.then((f) => f());
      void unSelect.then((f) => f());
    };
  }, []);

  // Silent incremental sync when window regains focus (throttled to >= 30s)
  useEffect(() => {
    if (!auth?.logged_in) return;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusSyncRef.current < 30_000) return;
      lastFocusSyncRef.current = now;
      void api
        .syncTasks()
        .then(() => refreshAll())
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [auth?.logged_in, view, query, sort]);

  useEffect(() => {
    if (auth?.logged_in) {
      void refreshAll(view, query, sort);
    }
  }, [view, query, sort, auth?.logged_in]);

  async function handleSync() {
    setBusy(true);
    try {
      const summary = await api.syncTasks();
      await refreshAll();
      showToast(
        `同步完成：共 ${summary.total_notes} 条笔记${
          summary.recovered_count > 0 ? `，已自动恢复 ${summary.recovered_count} 条元数据` : ""
        }`
      );
    } catch (e) {
      showToast(`同步失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(input: CreateTaskInput) {
    setBusy(true);
    try {
      const withList: CreateTaskInput = {
        ...input,
        list: input.list ?? activeList ?? null,
      };
      const created = await api.createTask(withList);
      setSelectedId(created.id);
      await refreshAll();
      showToast(`已创建「${created.title}」`);
    } catch (e) {
      showToast(`创建失败：${String(e)}`);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(id: number, patch: UpdateTaskInput) {
    try {
      await api.updateTask(id, patch);
      setConflictMsg(null);
      await refreshAll();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("TASK_CONFLICT")) {
        setConflictMsg("该任务已在其他设备或极空间官方记事本中被修改，请选择覆盖或刷新。");
      } else {
        showToast(`保存失败：${msg}`);
      }
      throw e;
    }
  }

  async function handleToggle(task: Task) {
    setBusy(true);
    try {
      const done = task.status === "completed" || task.status === "ended";
      if (done) {
        await api.reopenTask(task.id);
        await refreshAll();
        showToast(`已重新打开「${task.title}」`);
      } else {
        const prevKey = task.series?.cursor ?? null;
        const updated = await api.completeTask(task.id);
        await refreshAll();
        if (updated.repeat && updated.series && updated.status === "active") {
          showToast(
            `已完成本次 · 下次 ${dateLabel(updated.series.cursor)}`,
            async () => {
              if (prevKey) {
                await api.reopenTask(task.id, prevKey);
                await refreshAll();
              }
            }
          );
        } else {
          showToast(`已完成「${task.title}」`, async () => {
            await api.reopenTask(task.id);
            await refreshAll();
          });
        }
      }
    } catch (e) {
      showToast(`操作失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip(task: Task, key?: string) {
    setBusy(true);
    try {
      const actedKey = key ?? task.series?.cursor;
      const updated = await api.skipOccurrence(task.id, actedKey);
      await refreshAll();
      showToast(
        updated.series ? `已跳过本次 · 下次 ${dateLabel(updated.series.cursor)}` : "已跳过本次",
        actedKey
          ? async () => {
              await api.reopenTask(task.id, actedKey);
              await refreshAll();
            }
          : undefined
      );
    } catch (e) {
      showToast(`跳过失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleReopenOccurrence(task: Task, key: string) {
    setBusy(true);
    try {
      await api.reopenTask(task.id, key);
      await refreshAll();
      showToast(`已撤销 ${dateLabel(key)} 的记录`);
    } catch (e) {
      showToast(`撤销失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleEndSeries(task: Task) {
    setBusy(true);
    try {
      await api.endSeries(task.id);
      await refreshAll();
      showToast(`已终止重复系列「${task.title}」`);
    } catch (e) {
      showToast(`终止失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(task: Task) {
    setBusy(true);
    try {
      await api.deleteTask(task.id);
      if (selectedId === task.id) setSelectedId(null);
      await refreshAll();
      showToast(`已删除「${task.title}」（已移入极空间「最近删除」）`);
    } catch (e) {
      showToast(`删除失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCalendarReschedule(item: CalendarTaskItem, targetDate: string) {
    setBusy(true);
    try {
      if (item.is_repeating && item.occurrence_key) {
        await api.overrideOccurrence(item.task_id, item.occurrence_key, targetDate, item.time);
        showToast(`已将「${item.title}」本次调整到 ${dateLabel(targetDate)}`);
      } else {
        const current = await api.getTask(item.task_id, false);
        await api.updateTask(item.task_id, {
          schedule: {
            ...current.schedule,
            due: { date: targetDate, time: current.schedule.all_day ? null : item.time ?? null },
          },
          etag: current.etag,
        });
        showToast(`已将「${item.title}」改期到 ${dateLabel(targetDate)}`);
      }
      await refreshAll();
    } catch (e) {
      showToast(`改期失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCalendarToggle(item: CalendarTaskItem) {
    setBusy(true);
    try {
      if (item.done) {
        await api.reopenTask(item.task_id, item.occurrence_key);
      } else {
        await api.completeTask(item.task_id, item.occurrence_key);
      }
      await refreshAll();
    } catch (e) {
      showToast(`操作失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-slate-400">
        正在连接极空间…
      </div>
    );
  }

  if (!auth?.logged_in) {
    return <AuthScreen onAuthenticated={bootstrap} />;
  }

  const displayedTasks = activeList
    ? tasks.filter((t) => t.list === activeList)
    : activeLabel
    ? tasks.filter((t) => t.labels.includes(activeLabel))
    : tasks;
  const noSubFilter = !activeList && !activeLabel;
  const overdueToday =
    noSubFilter && view === "today" ? displayedTasks.filter(isTaskOverdue) : [];
  const normalToday =
    noSubFilter && view === "today"
      ? displayedTasks.filter((t) => !isTaskOverdue(t))
      : displayedTasks;

  const upcomingGroups =
    noSubFilter && view === "upcoming"
      ? Object.entries(
          displayedTasks.reduce<Record<string, Task[]>>((acc, t) => {
            const d = effectiveDue(t)?.date ?? "未安排";
            (acc[d] ??= []).push(t);
            return acc;
          }, {})
        ).sort(([a], [b]) => a.localeCompare(b))
      : [];

  return (
    <div className="flex h-screen bg-slate-50">
      {/* Dida365-style Leftmost Slim Navigation Rail */}
      <nav className="flex w-13 shrink-0 flex-col items-center border-r border-slate-200 bg-slate-100 py-3 gap-2">
        <div
          title={`极空间已连接 (${auth.nas_id ?? ""})`}
          className="mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-xs font-bold text-white shadow-xs"
        >
          Z
        </div>

        <button
          type="button"
          title="任务"
          onClick={() => setWorkspace("tasks")}
          className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${
            workspace === "tasks"
              ? "bg-white text-blue-600 shadow-xs"
              : "text-slate-500 hover:bg-slate-200/70"
          }`}
        >
          <CheckSquare className="h-5 w-5" />
        </button>

        <button
          type="button"
          title="月视图"
          onClick={() => setWorkspace("calendar")}
          className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${
            workspace === "calendar"
              ? "bg-white text-blue-600 shadow-xs"
              : "text-slate-500 hover:bg-slate-200/70"
          }`}
        >
          <CalendarDays className="h-5 w-5" />
        </button>

        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            type="button"
            title="快捷悬浮窗（Ctrl/Cmd+Shift+M）"
            onClick={() => void api.toggleFloatingWindow()}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70"
          >
            <PanelRightOpen className="h-4.5 w-4.5" />
          </button>

          <button
            type="button"
            title="通知中心"
            onClick={() => setShowNotif(true)}
            className="relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70"
          >
            <Bell className="h-4.5 w-4.5" />
            {unreadCount > 0 && (
              <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold text-white">
                {unreadCount}
              </span>
            )}
          </button>

          <button
            type="button"
            title="设置"
            onClick={() => setShowSettings(true)}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70"
          >
            <Settings className="h-4.5 w-4.5" />
          </button>
        </div>
      </nav>

      {/* Main Content Area: Tasks vs Month Calendar */}
      {workspace === "calendar" ? (
        <div className="flex min-w-0 flex-1">
          <MonthCalendarView
            lists={lists}
            selectedTaskId={selectedId}
            refreshToken={calendarRefreshToken}
            onSelectTask={(id) => {
              setSelectedId(id);
              setConflictMsg(null);
            }}
            onCreateTaskOnDate={handleCreate}
            onRescheduleItem={handleCalendarReschedule}
            onToggleItem={handleCalendarToggle}
            onSync={handleSync}
            busy={busy}
          />
          {selected && (
            <section className="relative w-[390px] shrink-0 border-l border-slate-200 bg-white">
              <button
                type="button"
                title="收起详情"
                onClick={() => setSelectedId(null)}
                className="absolute right-3 top-2 z-10 rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
              <TaskDetail
                task={selected}
                defaultAllDayTime={settings?.default_all_day_reminder_time}
                onUpdate={handleUpdate}
                onToggle={handleToggle}
                onSkip={handleSkip}
                onReopenOccurrence={handleReopenOccurrence}
                onEndSeries={handleEndSeries}
                onDelete={handleDelete}
                onReloadTask={async (id) => {
                  await api.getTask(id, true);
                  await refreshAll();
                }}
                conflictMessage={conflictMsg}
                onClearConflict={() => setConflictMsg(null)}
              />
            </section>
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1">
          {/* Task Views & Custom Lists Sidebar */}
          <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-slate-50/80 p-2.5 overflow-y-auto">
            <div className="space-y-0.5">
              {VIEW_ITEMS.map((item) => {
                const active = noSubFilter && view === item.key;
                const count =
                  item.key === "today"
                    ? viewCounts.today
                    : item.key === "inbox"
                    ? viewCounts.inbox
                    : item.key === "overdue"
                    ? viewCounts.overdue
                    : item.key === "repeating"
                    ? viewCounts.repeating
                    : item.key === "all"
                    ? viewCounts.all
                    : 0;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setActiveList(null);
                      setActiveLabel(null);
                      setView(item.key);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition ${
                      active
                        ? "bg-blue-50 font-medium text-blue-700"
                        : "text-slate-700 hover:bg-slate-200/60"
                    }`}
                  >
                    <span className={active ? "text-blue-600" : "text-slate-400"}>
                      {item.icon}
                    </span>
                    <span className="flex-1 text-left">{item.label}</span>
                    {count > 0 && (
                      <span
                        className={`text-xs ${
                          item.key === "overdue" ? "font-medium text-red-500" : "text-slate-400"
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mt-5">
              <div className="mb-1 flex items-center justify-between px-2.5 text-[11px] font-medium text-slate-400">
                <span>清单</span>
                <button
                  type="button"
                  title="新建清单"
                  onClick={() => setAddingList((v) => !v)}
                  className="rounded p-0.5 hover:bg-slate-200 hover:text-slate-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {addingList && (
                <input
                  autoFocus
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newListName.trim()) {
                      const n = newListName.trim();
                      setCustomLists((prev) => (prev.includes(n) ? prev : [...prev, n]));
                      setActiveList(n);
                      setActiveLabel(null);
                      setView("all");
                      setNewListName("");
                      setAddingList(false);
                    }
                    if (e.key === "Escape") {
                      setAddingList(false);
                      setNewListName("");
                    }
                  }}
                  onBlur={() => setAddingList(false)}
                  placeholder="清单名称，回车确认"
                  className="mb-1.5 w-full rounded-lg border border-blue-400 bg-white px-2.5 py-1 text-xs outline-none"
                />
              )}

              <div className="space-y-0.5">
                {lists.map((l) => {
                  const active = activeList === l;
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => {
                        setActiveList(l);
                        setActiveLabel(null);
                        setView("all");
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition ${
                        active
                          ? "bg-blue-50 font-medium text-blue-700"
                          : "text-slate-600 hover:bg-slate-200/60"
                      }`}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${listDotColor(l)}`} />
                      <span className="flex-1 truncate text-left">{l}</span>
                      {(listCounts[l] ?? 0) > 0 && (
                        <span className="text-[11px] text-slate-400">{listCounts[l]}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {allLabels.length > 0 && (
              <div className="mt-5">
                <div className="mb-1 px-2.5 text-[11px] font-medium text-slate-400">标签</div>
                <div className="space-y-0.5">
                  {allLabels.map((lb) => {
                    const active = activeLabel === lb;
                    return (
                      <button
                        key={lb}
                        type="button"
                        onClick={() => {
                          setActiveLabel(lb);
                          setActiveList(null);
                          setView("all");
                        }}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition ${
                          active
                            ? "bg-blue-50 font-medium text-blue-700"
                            : "text-slate-600 hover:bg-slate-200/60"
                        }`}
                      >
                        <span className="text-slate-400">#</span>
                        <span className="flex-1 truncate text-left">{lb}</span>
                        <span className="text-[11px] text-slate-400">{labelCounts[lb]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </aside>

          {/* Middle Task List */}
          <main className="flex min-w-0 flex-1 flex-col border-r border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold text-slate-900">
                  {activeList ??
                    (activeLabel ? `#${activeLabel}` : VIEW_ITEMS.find((v) => v.key === view)?.label)}
                </h1>
                <div className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1">
                  <Search className="h-3.5 w-3.5 text-slate-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索标题 / 备注 / 标签"
                    className="w-36 bg-transparent text-xs outline-none"
                  />
                </div>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as TaskSort)}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600"
                >
                  <option value="date">按截止日期</option>
                  <option value="priority">按优先级</option>
                  <option value="created">按创建时间</option>
                </select>
                <button
                  type="button"
                  disabled={busy}
                  title="立即与极空间同步"
                  onClick={() => void handleSync()}
                  className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                </button>
              </div>

              <QuickAddBar busy={busy} onCreate={handleCreate} />
            </div>

            <div className="flex-1 overflow-y-auto">
              {!activeList && view === "today" ? (
                <>
                  {overdueToday.length > 0 && (
                    <>
                      <div className="bg-red-50/70 px-3 py-1.5 text-xs font-semibold text-red-600">
                        已逾期 · {overdueToday.length}
                      </div>
                      {overdueToday.map((t) => (
                        <TaskListItem
                          key={t.id}
                          task={t}
                          selected={selectedId === t.id}
                          onSelect={(item) => {
                            setSelectedId(item.id);
                            setConflictMsg(null);
                          }}
                          onToggle={(item) => void handleToggle(item)}
                        />
                      ))}
                    </>
                  )}
                  <div className="bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-500">
                    今天 · {dateLabel(todayStr())}
                  </div>
                  {normalToday.length === 0 ? (
                    <div className="p-8 text-center text-sm text-slate-400">今天没有安排任务</div>
                  ) : (
                    normalToday.map((t) => (
                      <TaskListItem
                        key={t.id}
                        task={t}
                        selected={selectedId === t.id}
                        onSelect={(item) => {
                          setSelectedId(item.id);
                          setConflictMsg(null);
                        }}
                        onToggle={(item) => void handleToggle(item)}
                      />
                    ))
                  )}
                </>
              ) : !activeList && view === "upcoming" ? (
                upcomingGroups.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">未来 7 天没有到期任务</div>
                ) : (
                  upcomingGroups.map(([date, group]) => (
                    <div key={date}>
                      <div className="flex items-center gap-1.5 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-500">
                        <Calendar className="h-3.5 w-3.5" />
                        <span>{dateLabel(date)}</span>
                      </div>
                      {group.map((t) => (
                        <TaskListItem
                          key={t.id}
                          task={t}
                          selected={selectedId === t.id}
                          onSelect={(item) => {
                            setSelectedId(item.id);
                            setConflictMsg(null);
                          }}
                          onToggle={(item) => void handleToggle(item)}
                        />
                      ))}
                    </div>
                  ))
                )
              ) : displayedTasks.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400">暂无任务</div>
              ) : (
                displayedTasks.map((t) => (
                  <TaskListItem
                    key={t.id}
                    task={t}
                    selected={selectedId === t.id}
                    onSelect={(item) => {
                      setSelectedId(item.id);
                      setConflictMsg(null);
                    }}
                    onToggle={(item) => void handleToggle(item)}
                  />
                ))
              )}
            </div>
          </main>

          {/* Right Detail Panel */}
          <section className="w-[400px] shrink-0 bg-white">
            <TaskDetail
              task={selected}
              defaultAllDayTime={settings?.default_all_day_reminder_time}
              onUpdate={handleUpdate}
              onToggle={handleToggle}
              onSkip={handleSkip}
              onReopenOccurrence={handleReopenOccurrence}
              onEndSeries={handleEndSeries}
              onDelete={handleDelete}
              onReloadTask={async (id) => {
                await api.getTask(id, true);
                await refreshAll();
              }}
              conflictMessage={conflictMsg}
              onClearConflict={() => setConflictMsg(null)}
            />
          </section>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          auth={auth}
          onClose={() => setShowSettings(false)}
          onLogout={async () => {
            await api.logout();
            setShowSettings(false);
            setAuth({ logged_in: false, profile: "zspace-memo" });
          }}
          onSettingsChanged={(cfg) => {
            setSettings(cfg);
            void refreshAll();
          }}
        />
      )}

      {showNotif && (
        <NotificationDrawer
          notifications={notifications}
          onClose={() => setShowNotif(false)}
          onMarkRead={async (id) => {
            await api.markNotificationRead(id);
            setNotifications(await api.listNotifications(50));
          }}
          onSnooze={async (n, mins) => {
            await api.snoozeReminder(n.task_id, n.occurrence_key, mins, n.title, n.body);
            await api.markNotificationRead(n.id);
            setNotifications(await api.listNotifications(50));
            showToast(`已推迟 ${mins} 分钟后再次提醒`);
          }}
          onOpenTask={(id) => {
            setWorkspace("tasks");
            setSelectedId(id);
            setActiveList(null);
            setView("all");
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 px-4 py-2 text-xs text-white shadow-lg">
          <span>{toast.message}</span>
          {toast.undoLabel && toast.onUndo && (
            <button
              type="button"
              onClick={() => {
                const fn = toast.onUndo;
                setToast(null);
                void fn?.();
              }}
              className="font-semibold text-blue-400 hover:text-blue-300"
            >
              {toast.undoLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
