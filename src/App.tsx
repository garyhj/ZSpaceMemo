import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  Bell,
  Calendar,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  ChevronRight,
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
import { TaskContextMenu, type ContextMenuState } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { TaskListItem } from "./components/TaskListItem";
import type {
  AppSettings,
  AuthStatus,
  CalendarTaskItem,
  CreateTaskInput,
  NotificationRecord,
  Priority,
  Task,
  TaskSort,
  TaskView,
  UpdateTaskInput,
} from "./types";
import { dateLabel, effectiveDue, formatDate, isTaskOverdue, todayStr } from "./utils/date";
import { setPrefs, usePrefs } from "./utils/prefs";

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
  const [completedTasks, setCompletedTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [dragOverList, setDragOverList] = useState<string | null>(null);
  const prefs = usePrefs();

  const lastFocusSyncRef = useRef<number>(0);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () =>
      tasks.find((t) => t.id === selectedId) ??
      allActive.find((t) => t.id === selectedId) ??
      completedTasks.find((t) => t.id === selectedId) ??
      null,
    [tasks, allActive, completedTasks, selectedId]
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
      const [list, active, done, notifs] = await Promise.all([
        api.listTasks(v, q, s),
        api.listTasks("all", undefined, "date"),
        api.listTasks("completed", q || undefined, "date"),
        api.listNotifications(50),
      ]);
      setTasks(list);
      setAllActive(active);
      setCompletedTasks(done);
      setNotifications(notifs);
      setCalendarRefreshToken((n) => n + 1);
    } catch (e) {
      showToast(`刷新列表失败：${String(e)}`);
    } finally {
      setLoaded(true);
    }
  }

  async function bootstrap(st: AuthStatus) {
    setAuth(st);
    if (!st.logged_in) return;
    try {
      const cfg = await api.getSettings();
      setSettings(cfg);
      await refreshAll();
    } catch (e) {
      showToast(`加载本地缓存失败：${String(e)}`);
    }
    setBusy(true);
    try {
      await api.initializeCategory(true);
      await api.syncTasks();
      await refreshAll();
    } catch (e) {
      showToast(`后台同步失败：${String(e)}`);
    } finally {
      setBusy(false);
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

  function applyLocalTaskPatch(id: number, updater: (t: Task) => Task) {
    setTasks((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
    setAllActive((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
  }

  async function handleCreate(input: CreateTaskInput) {
    const withList: CreateTaskInput = {
      ...input,
      list: input.list ?? activeList ?? null,
    };
    const tempId = -Date.now();
    const optimistic: Task = {
      id: tempId,
      title: withList.title,
      description: withList.description ?? "",
      rich_body_protected: false,
      status: "pending",
      priority: withList.priority ?? "normal",
      list: withList.list ?? null,
      labels: withList.labels ?? [],
      pinned: withList.pinned ?? false,
      schedule: withList.schedule ?? { all_day: false, due: null, timezone: "Asia/Shanghai" },
      reminders: withList.reminders ?? [],
      repeat: withList.repeat ?? null,
      series: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: "zspace_notebook",
      meta_state: "ok",
      rev: 0,
      etag: "",
    };
    setTasks((prev) => [optimistic, ...prev]);
    setAllActive((prev) => [optimistic, ...prev]);
    setSelectedId(tempId);

    try {
      const created = await api.createTask(withList);
      setSelectedId((cur) => (cur === tempId ? created.id : cur));
      await refreshAll();
      showToast(`已创建「${created.title}」`);
    } catch (e) {
      setTasks((prev) => prev.filter((t) => t.id !== tempId));
      setAllActive((prev) => prev.filter((t) => t.id !== tempId));
      setSelectedId((cur) => (cur === tempId ? null : cur));
      showToast(`创建失败：${String(e)}`);
      throw e;
    }
  }

  async function handleUpdate(id: number, patch: UpdateTaskInput) {
    const prevTasks = tasks;
    const prevActive = allActive;

    applyLocalTaskPatch(id, (t) => ({
      ...t,
      title: patch.title ?? t.title,
      description: patch.description ?? t.description,
      status: patch.status ?? t.status,
      priority: patch.priority ?? t.priority,
      list: patch.list !== undefined ? patch.list : t.list,
      labels: patch.labels ?? t.labels,
      pinned: patch.pinned ?? t.pinned,
      schedule: patch.schedule ?? t.schedule,
      reminders: patch.reminders ?? t.reminders,
      repeat: patch.repeat !== undefined ? patch.repeat : t.repeat,
    }));

    try {
      const saved = await api.updateTask(id, patch);
      applyLocalTaskPatch(id, () => saved);
      setConflictMsg(null);
      void refreshAll();
    } catch (e) {
      setTasks(prevTasks);
      setAllActive(prevActive);
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
    const prevTasks = tasks;
    const prevActive = allActive;
    const prevCompleted = completedTasks;
    const done = task.status === "completed" || task.status === "ended";

    // Optimistically update UI immediately (0ms latency)
    if (!task.repeat) {
      if (!done && view !== "completed") {
        const now = new Date().toISOString();
        setTasks((prev) => prev.filter((t) => t.id !== task.id));
        setAllActive((prev) => prev.filter((t) => t.id !== task.id));
        setCompletedTasks((prev) => [
          { ...task, status: "completed", completed_at: now },
          ...prev.filter((t) => t.id !== task.id),
        ]);
      } else if (done && view !== "completed") {
        const reopened: Task = { ...task, status: "pending", completed_at: null };
        setCompletedTasks((prev) => prev.filter((t) => t.id !== task.id));
        setTasks((prev) => [reopened, ...prev.filter((t) => t.id !== task.id)]);
        setAllActive((prev) => [reopened, ...prev.filter((t) => t.id !== task.id)]);
      } else {
        applyLocalTaskPatch(task.id, (t) => ({ ...t, status: done ? "pending" : "completed" }));
      }
    }

    try {
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
      setTasks(prevTasks);
      setAllActive(prevActive);
      setCompletedTasks(prevCompleted);
      showToast(`操作失败：${String(e)}`);
    }
  }

  async function handleSkip(task: Task, key?: string) {
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
    }
  }

  async function handleReopenOccurrence(task: Task, key: string) {
    try {
      await api.reopenTask(task.id, key);
      await refreshAll();
      showToast(`已撤销 ${dateLabel(key)} 的记录`);
    } catch (e) {
      showToast(`撤销失败：${String(e)}`);
    }
  }

  async function handleEndSeries(task: Task) {
    try {
      await api.endSeries(task.id);
      await refreshAll();
      showToast(`已终止重复系列「${task.title}」`);
    } catch (e) {
      showToast(`终止失败：${String(e)}`);
    }
  }

  async function handleDelete(task: Task) {
    const prevTasks = tasks;
    const prevActive = allActive;
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    setAllActive((prev) => prev.filter((t) => t.id !== task.id));
    if (selectedId === task.id) setSelectedId(null);

    try {
      await api.deleteTask(task.id);
      void refreshAll();
      showToast(`已删除「${task.title}」（已移入极空间「最近删除」）`);
    } catch (e) {
      setTasks(prevTasks);
      setAllActive(prevActive);
      showToast(`删除失败：${String(e)}`);
    }
  }

  async function handleCalendarReschedule(item: CalendarTaskItem, targetDate: string) {
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
    }
  }

  async function handleCalendarToggle(item: CalendarTaskItem) {
    try {
      if (item.done) {
        await api.reopenTask(item.task_id, item.occurrence_key);
      } else {
        await api.completeTask(item.task_id, item.occurrence_key);
      }
      await refreshAll();
    } catch (e) {
      showToast(`操作失败：${String(e)}`);
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

  // Dida365-style collapsible "已完成" group at the bottom of the current view.
  const todayKey = todayStr();
  const completedDay = (t: Task) => (t.completed_at ? formatDate(new Date(t.completed_at)) : null);
  const completedForView =
    view === "completed"
      ? []
      : completedTasks
          .filter((t) => {
            if (t.repeat || t.status !== "completed") return false;
            if (activeList) return t.list === activeList;
            if (activeLabel) return t.labels.includes(activeLabel);
            const due = t.schedule.due?.date ?? null;
            if (view === "today") return due === todayKey || completedDay(t) === todayKey;
            if (view === "inbox") return !due;
            if (view === "all") {
              const d = completedDay(t);
              return d !== null && d >= formatDate(new Date(Date.now() - 7 * 86_400_000));
            }
            return false;
          })
          .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
          .slice(0, 50);

  const selectTask = (item: Task) => {
    setSelectedId(item.id);
    setConflictMsg(null);
  };
  const toggleTask = (item: Task) => void handleToggle(item);
  const openMenu = (task: Task, x: number, y: number, mode: "full" | "date" = "full") => {
    setCtxMenu({ task, x, y, mode });
  };
  const renderTask = (t: Task) => (
    <TaskListItem
      key={t.id}
      task={t}
      selected={selectedId === t.id}
      onSelect={selectTask}
      onToggle={toggleTask}
      onOpenMenu={openMenu}
    />
  );

  // Ordered visible task list for ArrowUp / ArrowDown keyboard navigation
  const visibleTaskOrder = useMemo(() => {
    const base =
      !activeList && !activeLabel && view === "today"
        ? [...overdueToday, ...normalToday]
        : !activeList && !activeLabel && view === "upcoming"
        ? upcomingGroups.flatMap(([, g]) => g)
        : displayedTasks;
    return prefs.showCompletedGroup ? [...base, ...completedForView] : base;
  }, [activeList, activeLabel, view, overdueToday, normalToday, upcomingGroups, displayedTasks, prefs.showCompletedGroup, completedForView]);

  const setTaskDate = async (task: Task, date: string | null) => {
    await handleUpdate(task.id, {
      schedule: {
        ...task.schedule,
        all_day: date ? task.schedule.all_day || !task.schedule.due?.time : false,
        due: date ? { date, time: task.schedule.all_day ? null : task.schedule.due?.time ?? null } : null,
      },
      etag: task.etag,
    });
    showToast(date ? `已调整到 ${dateLabel(date)}` : "已清除截止日期");
  };

  // Global keyboard shortcuts (Dida365-style)
  useEffect(() => {
    if (!auth?.logged_in) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing = Boolean(
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      );
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setWorkspace("tasks");
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (mod && (e.key === "1" || e.key === "2")) {
        e.preventDefault();
        setWorkspace(e.key === "1" ? "tasks" : "calendar");
        return;
      }
      if (e.key === "Escape") {
        if (ctxMenu) { setCtxMenu(null); return; }
        if (showSettings) { setShowSettings(false); return; }
        if (showNotif) { setShowNotif(false); return; }
        if (editing) { target?.blur(); return; }
        if (query) { setQuery(""); return; }
        if (selectedId !== null) setSelectedId(null);
        return;
      }
      if (editing || showSettings || showNotif) return;

      if (e.key === "/" ) {
        e.preventDefault();
        setWorkspace("tasks");
        searchRef.current?.focus();
      } else if (e.key.toLowerCase() === "n" && !mod) {
        e.preventDefault();
        setWorkspace("tasks");
        requestAnimationFrame(() => quickAddRef.current?.focus());
      } else if (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") {
        const map: Record<string, TaskView> = { "1": "today", "2": "upcoming", "3": "inbox", "4": "all" };
        setWorkspace("tasks");
        setActiveList(null);
        setActiveLabel(null);
        setView(map[e.key]);
      } else if (workspace === "tasks" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        if (visibleTaskOrder.length === 0) return;
        e.preventDefault();
        const idx = visibleTaskOrder.findIndex((t) => t.id === selectedId);
        const nextIdx =
          idx < 0
            ? 0
            : e.key === "ArrowDown"
            ? Math.min(visibleTaskOrder.length - 1, idx + 1)
            : Math.max(0, idx - 1);
        const nextId = visibleTaskOrder[nextIdx].id;
        setSelectedId(nextId);
        setConflictMsg(null);
        requestAnimationFrame(() => {
          document.querySelector(`[data-task-id="${nextId}"]`)?.scrollIntoView({ block: "nearest" });
        });
      } else if (selected && (e.key === " " || (mod && e.key === "Enter"))) {
        e.preventDefault();
        void handleToggle(selected);
      } else if (selected && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        if (window.confirm(`确定删除「${selected.title}」吗？`)) {
          void handleDelete(selected);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [auth?.logged_in, workspace, selectedId, selected, visibleTaskOrder, ctxMenu, showSettings, showNotif, query]);
  const groupHeader = (label: React.ReactNode, tone: "default" | "danger" = "default") => (
    <div
      className={`sticky top-0 z-10 bg-white/95 px-2.5 pb-1 pt-3 text-xs font-semibold backdrop-blur ${
        tone === "danger" ? "text-red-500" : "text-slate-500"
      }`}
    >
      {label}
    </div>
  );

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
            onContextMenuTask={(taskId, x, y) => {
              const t = allActive.find((x) => x.id === taskId) ?? completedTasks.find((x) => x.id === taskId);
              if (t) openMenu(t, x, y, "full");
            }}
            onSync={handleSync}
            busy={busy}
          />
          {selected && (
            <section className="w-[390px] shrink-0 border-l border-slate-200 bg-white">
              <TaskDetail
                task={selected}
                lists={lists}
                defaultAllDayTime={settings?.default_all_day_reminder_time}
                onClose={() => setSelectedId(null)}
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
                    onDragOver={(e) => {
                      if (item.key !== "inbox") return;
                      e.preventDefault();
                      if (dragOverList !== "__inbox__") setDragOverList("__inbox__");
                    }}
                    onDragLeave={() => {
                      if (dragOverList === "__inbox__") setDragOverList(null);
                    }}
                    onDrop={(e) => {
                      if (item.key !== "inbox") return;
                      e.preventDefault();
                      setDragOverList(null);
                      const id = Number(e.dataTransfer.getData("text/x-zsm-task-id"));
                      const t = allActive.find((x) => x.id === id);
                      if (t && t.list) {
                        void handleUpdate(t.id, { list: null, etag: t.etag });
                        showToast(`已将「${t.title}」移出清单`);
                      }
                    }}
                    onClick={() => {
                      setActiveList(null);
                      setActiveLabel(null);
                      setView(item.key);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition ${
                      item.key === "inbox" && dragOverList === "__inbox__"
                        ? "bg-blue-100 ring-1 ring-blue-400"
                        : active
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
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragOverList !== l) setDragOverList(l);
                      }}
                      onDragLeave={() => {
                        if (dragOverList === l) setDragOverList(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverList(null);
                        const id = Number(e.dataTransfer.getData("text/x-zsm-task-id"));
                        const t = allActive.find((x) => x.id === id);
                        if (t && t.list !== l) {
                          void handleUpdate(t.id, { list: l, etag: t.etag });
                          showToast(`已移动到清单「${l}」`);
                        }
                      }}
                      onClick={() => {
                        setActiveList(l);
                        setActiveLabel(null);
                        setView("all");
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition ${
                        dragOverList === l
                          ? "bg-blue-100 ring-1 ring-blue-400"
                          : active
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
          <main className="flex min-w-0 flex-1 flex-col border-r border-slate-200/80 bg-white">
            <div className="space-y-2.5 px-4 pb-2 pt-3.5">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold tracking-tight text-slate-900">
                  {activeList ??
                    (activeLabel ? `#${activeLabel}` : VIEW_ITEMS.find((v) => v.key === view)?.label)}
                </h1>
                <button
                  type="button"
                  title={busy ? "正在同步…" : "立即与极空间同步"}
                  onClick={() => !busy && void handleSync()}
                  className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin text-blue-500" : ""}`} />
                </button>
                <div className="ml-auto flex items-center gap-1.5 rounded-md bg-slate-100/80 px-2 py-1 focus-within:bg-white focus-within:ring-1 focus-within:ring-blue-400">
                  <Search className="h-3.5 w-3.5 text-slate-400" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setQuery("");
                        searchRef.current?.blur();
                      }
                    }}
                    placeholder="搜索 (Ctrl+K)"
                    className="w-32 bg-transparent text-xs outline-none placeholder:text-slate-400"
                  />
                  {query && (
                    <button type="button" onClick={() => setQuery("")} className="text-slate-400 hover:text-slate-600">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <select
                  value={sort}
                  title="排序"
                  onChange={(e) => setSort(e.target.value as TaskSort)}
                  className="rounded-md bg-transparent px-1.5 py-1 text-xs text-slate-500 outline-none hover:bg-slate-100"
                >
                  <option value="date">按日期</option>
                  <option value="priority">按优先级</option>
                  <option value="created">按创建时间</option>
                </select>
              </div>

              <QuickAddBar inputRef={quickAddRef} lists={lists} onCreate={handleCreate} />
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-6">
              {!loaded ? (
                <div className="space-y-3 px-2.5 pt-4">
                  {[72, 55, 64, 40, 58].map((w, i) => (
                    <div key={i} className="flex items-center gap-2.5">
                      <div className="skeleton h-4 w-4" />
                      <div className="skeleton h-3.5" style={{ width: `${w}%` }} />
                    </div>
                  ))}
                </div>
              ) : !activeList && !activeLabel && view === "today" ? (
                <>
                  {overdueToday.length > 0 && (
                    <>
                      {groupHeader(<>已过期 <span className="font-normal">{overdueToday.length}</span></>, "danger")}
                      {overdueToday.map(renderTask)}
                    </>
                  )}
                  {groupHeader(<>今天 <span className="font-normal text-slate-400">{normalToday.length}</span></>)}
                  {normalToday.length === 0 && overdueToday.length === 0 ? (
                    <EmptyState text={completedForView.length > 0 ? "今天的任务都完成了 🎉" : "今天没有安排任务"} />
                  ) : (
                    normalToday.map(renderTask)
                  )}
                </>
              ) : !activeList && !activeLabel && view === "upcoming" ? (
                upcomingGroups.length === 0 ? (
                  <EmptyState text="接下来几天没有到期任务" />
                ) : (
                  upcomingGroups.map(([date, group]) => (
                    <div key={date}>
                      {groupHeader(
                        <span className="inline-flex items-center gap-1.5">
                          <Calendar className="h-3.5 w-3.5" />
                          {dateLabel(date)}
                          <span className="font-normal text-slate-400">{group.length}</span>
                        </span>
                      )}
                      {group.map(renderTask)}
                    </div>
                  ))
                )
              ) : displayedTasks.length === 0 ? (
                <EmptyState text={completedForView.length > 0 ? "全部完成 🎉" : "暂无任务"} />
              ) : (
                <div className="pt-1">{displayedTasks.map(renderTask)}</div>
              )}

              {loaded && completedForView.length > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setPrefs({ showCompletedGroup: !prefs.showCompletedGroup })}
                    className="flex w-full items-center gap-1 px-2.5 pb-1 pt-3 text-xs font-semibold text-slate-400 hover:text-slate-600"
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 transition-transform ${prefs.showCompletedGroup ? "rotate-90" : ""}`}
                    />
                    已完成
                    <span className="font-normal">{completedForView.length}</span>
                  </button>
                  {prefs.showCompletedGroup && (
                    <div className="animate-fade-in">{completedForView.map(renderTask)}</div>
                  )}
                </div>
              )}
            </div>
          </main>

          {/* Right Detail Panel */}
          <section className="w-[400px] shrink-0 bg-white">
            <TaskDetail
              task={selected}
              lists={lists}
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

      {ctxMenu && (
        <TaskContextMenu
          menu={ctxMenu}
          lists={lists}
          onClose={() => setCtxMenu(null)}
          onSetDate={(t, d) => void setTaskDate(t, d)}
          onSetPriority={(t, p: Priority) => void handleUpdate(t.id, { priority: p, etag: t.etag })}
          onTogglePin={(t) => void handleUpdate(t.id, { pinned: !t.pinned, etag: t.etag })}
          onToggleDone={(t) => void handleToggle(t)}
          onMoveToList={(t, l) => {
            void handleUpdate(t.id, { list: l, etag: t.etag });
            showToast(l ? `已移动到「${l}」` : "已移出清单");
          }}
          onCopyTitle={(t) => {
            void navigator.clipboard?.writeText(t.title);
            showToast("已复制任务标题");
          }}
          onDelete={(t) => {
            if (window.confirm(`确定删除「${t.title}」吗？`)) {
              void handleDelete(t);
            }
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

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-slate-400">
      <CheckCircle2 className="h-10 w-10 text-slate-200" strokeWidth={1.5} />
      {text}
    </div>
  );
}
