import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Download,
  Inbox,
  Layers,
  List as ListIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { AuthScreen } from "./components/AuthScreen";
import { QuickAddBar } from "./components/QuickAddBar";
import { TaskContextMenu, type ContextMenuState } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { TaskListItem } from "./components/TaskListItem";
import { TOOLBOX_MODULES, type WorkspaceId } from "./modules/registry";

const FloatingWindow = lazy(() =>
  import("./components/FloatingWindow").then((m) => ({ default: m.FloatingWindow }))
);
const MonthCalendarView = lazy(() =>
  import("./components/MonthCalendarView").then((m) => ({ default: m.MonthCalendarView }))
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal }))
);
const DockerBoardView = lazy(() =>
  import("./modules/docker/DockerBoardView").then((m) => ({ default: m.DockerBoardView }))
);
const DownloaderView = lazy(() =>
  import("./modules/downloader/DownloaderView").then((m) => ({ default: m.DownloaderView }))
);
const FileDropView = lazy(() =>
  import("./modules/files/FileDropView").then((m) => ({ default: m.FileDropView }))
);
const NasStatusView = lazy(() =>
  import("./modules/nas/NasStatusView").then((m) => ({ default: m.NasStatusView }))
);
const StickyBoard = lazy(() =>
  import("./modules/sticky/StickyBoard").then((m) => ({ default: m.StickyBoard }))
);
const StickyFloatingCard = lazy(() =>
  import("./modules/sticky/StickyFloatingCard").then((m) => ({ default: m.StickyFloatingCard }))
);
import {
  checkLatestRelease,
  formatBytesCompact,
  startInAppUpdate,
  type ReleaseUpdateInfo,
  type UpdateProgressEvent,
} from "./utils/updater";
import type {
  AppSettings,
  AuthStatus,
  CalendarTaskItem,
  CreateTaskInput,
  Priority,
  Schedule,
  Task,
  TaskAttachment,
  TaskSort,
  TaskView,
  UpdateTaskInput,
} from "./types";
import { dateLabel, effectiveDue, formatDate, isTaskOverdue, listColorHex, todayStr } from "./utils/date";
import { setPrefs, usePrefs } from "./utils/prefs";

function DayBadgeIcon({ label }: { label: string | number }) {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-current text-[9.5px] font-semibold leading-none tracking-tighter tabular-nums">
      {label}
    </span>
  );
}

const PRIMARY_VIEW_ITEMS: { key: TaskView; label: string; icon: (todayDay: number, days: number) => React.ReactNode }[] = [
  { key: "all", label: "所有", icon: () => <Layers className="h-4 w-4" strokeWidth={1.75} /> },
  { key: "today", label: "今天", icon: (day) => <DayBadgeIcon label={day} /> },
  { key: "upcoming", label: "最近7天", icon: (_day, days) => <DayBadgeIcon label={days} /> },
  { key: "inbox", label: "收集箱", icon: () => <Inbox className="h-4 w-4" strokeWidth={1.75} /> },
];

const SECONDARY_VIEW_ITEMS: { key: TaskView; label: string; icon: React.ReactNode }[] = [
  { key: "overdue", label: "已逾期", icon: <AlertCircle className="h-4 w-4" strokeWidth={1.75} /> },
  { key: "repeating", label: "重复任务", icon: <Repeat className="h-4 w-4" strokeWidth={1.75} /> },
  { key: "completed", label: "已完成", icon: <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> },
];

const ALL_VIEW_LABELS: Record<TaskView, string> = {
  all: "所有",
  today: "今天",
  upcoming: "最近7天",
  inbox: "收集箱",
  overdue: "已逾期",
  repeating: "重复任务",
  completed: "已完成",
};

interface ToastState {
  message: string;
  undoLabel?: string;
  onUndo?: () => Promise<void>;
}

function customListsStorageKey(authStatus: AuthStatus | null): string {
  const acct = authStatus?.nas_id || authStatus?.profile || "default";
  return `zsm_custom_lists_v1:${acct}`;
}

function loadSavedCustomLists(authStatus: AuthStatus | null): string[] {
  try {
    const raw = localStorage.getItem(customListsStorageKey(authStatus));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0))
    );
  } catch {
    return [];
  }
}

function WorkspaceLoadingShell({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex items-center justify-center text-xs text-slate-400 ${
        compact ? "h-screen w-screen" : "flex-1"
      }`}
    >
      正在加载组件…
    </div>
  );
}

export default function App() {
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const allow =
        Boolean(
          target &&
            (target.tagName === "INPUT" ||
              target.tagName === "TEXTAREA" ||
              target.tagName === "SELECT" ||
              target.isContentEditable ||
              target.closest("pre, code, .select-text"))
        ) || Boolean(window.getSelection()?.toString());
      if (!allow) e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const mode = params.get("mode");

  if (mode === "floating") {
    return (
      <Suspense fallback={<WorkspaceLoadingShell compact />}>
        <FloatingWindow />
      </Suspense>
    );
  }
  if (mode === "sticky") {
    const rawId = params.get("id");
    const id = Number(rawId || "0");
    if (Number.isInteger(id) && id > 0) {
      return (
        <Suspense fallback={<WorkspaceLoadingShell compact />}>
          <StickyFloatingCard noteId={id} />
        </Suspense>
      );
    }
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-amber-50 p-4 text-center text-xs text-slate-600">
        <div>无效的桌面便签参数（id={rawId ?? "空"}）</div>
        <button
          type="button"
          onClick={() => window.close()}
          className="rounded-lg bg-slate-800 px-3 py-1 text-white hover:bg-slate-700"
        >
          关闭窗口
        </button>
      </div>
    );
  }

  return <MainWindow />;
}

function MainWindow() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Dida365 top-level workspace switcher: Tasks vs Month Calendar
  const [workspace, setWorkspace] = useState<WorkspaceId>("tasks");
  const [view, setView] = useState<TaskView>("today");
  const [activeList, setActiveList] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [customLists, setCustomLists] = useState<string[]>([]);
  const customListsAccountRef = useRef<string | null>(null);
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState("");

  const [sort, setSort] = useState<TaskSort>("date");
  const [query, setQuery] = useState("");
  const filtersRef = useRef({ view, query, sort });
  filtersRef.current = { view, query, sort };
  const refreshSeqRef = useRef(0);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [allActive, setAllActive] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<ReleaseUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgressEvent | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const installingUpdateRef = useRef(false);
  installingUpdateRef.current = installingUpdate;
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [postponing, setPostponing] = useState(false);

  async function handleInstallUpdate(info: ReleaseUpdateInfo) {
    installingUpdateRef.current = true;
    setInstallingUpdate(true);
    setUpdateError(null);
    setUpdateDismissed(false);
    setUpdateProgress({
      phase: "downloading",
      downloaded: 0,
      total: info.asset_size ?? null,
      percent: 0,
      message: "正在准备下载更新包…",
    });
    try {
      await startInAppUpdate(info);
    } catch (e) {
      installingUpdateRef.current = false;
      setUpdateError(String(e));
      setInstallingUpdate(false);
      setUpdateProgress(null);
    }
  }
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

  useEffect(() => {
    if (!auth?.logged_in || !customListsAccountRef.current) return;
    try {
      localStorage.setItem(customListsAccountRef.current, JSON.stringify(customLists));
    } catch {
      // ignore storage quota errors
    }
  }, [customLists, auth?.logged_in]);

  const selected = useMemo(
    () =>
      tasks.find((t) => t.id === selectedId) ??
      allActive.find((t) => t.id === selectedId) ??
      completedTasks.find((t) => t.id === selectedId) ??
      null,
    [tasks, allActive, completedTasks, selectedId]
  );

  const lists = useMemo(() => {
    const set = new Set<string>(customLists);
    for (const t of allActive) {
      if (t.list) set.add(t.list);
    }
    for (const t of completedTasks) {
      if (t.list) set.add(t.list);
    }
    return Array.from(set).sort();
  }, [allActive, completedTasks, customLists]);

  // Sidebar live counts
  const upcomingDays = settings?.upcoming_days ?? 7;
  const viewCounts = useMemo(() => {
    const today = todayStr();
    const upcomingEnd = formatDate(new Date(Date.now() + upcomingDays * 86_400_000));
    let inbox = 0;
    let todayCount = 0;
    let upcoming = 0;
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
      if (due && due.date > today && due.date <= upcomingEnd) {
        upcoming++;
      }
    }
    return {
      inbox,
      today: todayCount,
      upcoming,
      overdue,
      repeating,
      all: allActive.length,
    };
  }, [allActive, settings?.show_overdue_in_today, upcomingDays]);

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

  async function refreshAll(
    v = filtersRef.current.view,
    q = filtersRef.current.query,
    s = filtersRef.current.sort
  ) {
    const seq = ++refreshSeqRef.current;
    try {
      const [list, active, done] = await Promise.all([
        api.listTasks(v, q, s),
        api.listTasks("all", undefined, "date"),
        api.listTasks("completed", q || undefined, "date"),
      ]);
      if (seq !== refreshSeqRef.current) return;
      setTasks(list);
      setAllActive(active);
      setCompletedTasks(done);
      setCalendarRefreshToken((n) => n + 1);
    } catch (e) {
      showToast(`刷新列表失败：${String(e)}`);
    } finally {
      if (seq === refreshSeqRef.current) {
        setLoaded(true);
      }
    }
  }

  async function bootstrap(st: AuthStatus) {
    setAuth(st);
    if (!st.logged_in) {
      customListsAccountRef.current = null;
      return;
    }
    customListsAccountRef.current = customListsStorageKey(st);
    setCustomLists(loadSavedCustomLists(st));
    try {
      const cfg = await api.getSettings();
      setSettings(cfg);
      await refreshAll();
    } catch (e) {
      showToast(`加载本地缓存失败：${String(e)}`);
    } finally {
      setAuthChecked(true);
    }

    setBusy(true);
    lastFocusSyncRef.current = Date.now();
    void (async () => {
      try {
        await api.initializeCategory(true);
        await api.syncTasks();
        await refreshAll();
        void api.initStickyCategory(true).then(() => api.syncStickyNotes()).catch(() => {});
      } catch (e) {
        showToast(`后台同步失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    })();
  }

  useEffect(() => {
    api
      .authStatus()
      .then((st) => bootstrap(st))
      .catch(async (e) => {
        if (!(e instanceof ApiError && e.code === "NAS_AUTH_REQUIRED")) {
          try {
            const cfg = await api.getSettings();
            if (cfg.todo_category_id != null) {
              setSettings(cfg);
              await refreshAll();
              setAuth({ logged_in: true, profile: "zspace-memo" });
              showToast(`离线模式已加载本地缓存：${String(e)}`);
              return;
            }
          } catch {
            // Fall through to AuthScreen
          }
        }
        setAuth({ logged_in: false, profile: "zspace-memo" });
      })
      .finally(() => setAuthChecked(true));

    const onAuthExpired = () => {
      setAuth((prev) =>
        prev?.logged_in ? { logged_in: false, profile: prev.profile || "zspace-memo" } : prev
      );
      showToast("极空间登录态已失效，请重新登录授权");
    };
    window.addEventListener("zsm:auth-expired", onAuthExpired);

    const unSynced = listen("tasks:synced", () => {
      void refreshAll();
    });
    const unChanged = listen<string>("tasks:changed", (ev) => {
      if (ev.payload !== "main") void refreshAll();
    });
    const unSelect = listen<number>("task:select", (ev) => {
      setWorkspace("tasks");
      setSelectedId(ev.payload);
      setView("all");
      setActiveList(null);
    });
    const unNavigate = listen<string>("workspace:navigate", (ev) => {
      const ws = ev.payload as WorkspaceId;
      if (TOOLBOX_MODULES.some((m) => m.id === ws)) {
        setWorkspace(ws);
      }
    });
    const unUpdateProg = listen<UpdateProgressEvent>("update:progress", (ev) => {
      const payload = ev.payload;
      if (!installingUpdateRef.current) return;
      setUpdateProgress(payload);
      if (payload.phase === "error") {
        installingUpdateRef.current = false;
        setInstallingUpdate(false);
        setUpdateError(payload.message);
      } else if (payload.phase === "done") {
        installingUpdateRef.current = false;
        setInstallingUpdate(false);
      }
    });

    const updateTimer = window.setTimeout(() => {
      checkLatestRelease()
        .then((info) => {
          setUpdateInfo(info);
        })
        .catch(() => {});
    }, 2500);

    return () => {
      window.clearTimeout(updateTimer);
      window.removeEventListener("zsm:auth-expired", onAuthExpired);
      void unSynced.then((f) => f());
      void unChanged.then((f) => f());
      void unSelect.then((f) => f());
      void unNavigate.then((f) => f());
      void unUpdateProg.then((f) => f());
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
    setCompletedTasks((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
  }

  async function handleCreate(input: CreateTaskInput) {
    let autoReminders = input.reminders;
    if (
      input.schedule?.due &&
      (!autoReminders || autoReminders.length === 0) &&
      settings?.default_auto_remind !== false
    ) {
      const isTimed = !input.schedule.all_day && Boolean(input.schedule.due.time);
      autoReminders = [
        isTimed
          ? { type: "relative", id: "auto_due", offset_minutes: 0 }
          : {
              type: "relative",
              id: "auto_day",
              offset_days: 0,
              day_time: settings?.default_all_day_reminder_time ?? "09:00",
            },
      ];
    }
    const withList: CreateTaskInput = {
      ...input,
      reminders: autoReminders,
      list: input.list !== undefined ? input.list : workspace === "tasks" ? activeList : null,
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

  async function handleUpdate(id: number, patch: UpdateTaskInput): Promise<Task> {
    const prevTasks = tasks;
    const prevActive = allActive;
    const prevCompleted = completedTasks;

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
      attachments: patch.attachments ?? t.attachments,
    }));

    try {
      const saved = await api.updateTask(id, patch);
      applyLocalTaskPatch(id, () => saved);
      setConflictMsg(null);
      void refreshAll();
      return saved;
    } catch (e) {
      setTasks(prevTasks);
      setAllActive(prevActive);
      setCompletedTasks(prevCompleted);
      const msg = String(e);
      if ((e instanceof ApiError && e.code === "TASK_CONFLICT") || msg.includes("TASK_CONFLICT")) {
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
        const prevKey = task.effective_current_key ?? task.series?.cursor ?? null;
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

  async function handleOverrideOccurrence(
    task: Task,
    occurrenceKey: string,
    nextSchedule: Schedule
  ) {
    if (!nextSchedule.due) return;
    try {
      await api.overrideOccurrence(
        task.id,
        occurrenceKey,
        nextSchedule.due.date,
        nextSchedule.all_day ? null : nextSchedule.due.time ?? null,
        nextSchedule.all_day,
        null
      );
      await refreshAll();
      showToast(
        `已将「${task.title}」本次调整到 ${dateLabel(nextSchedule.due.date)}`
      );
    } catch (e) {
      showToast(`单独调整失败：${String(e)}`);
    }
  }

  async function handleClearOccurrenceOverride(task: Task, occurrenceKey: string) {
    try {
      await api.clearOccurrenceOverride(task.id, occurrenceKey);
      await refreshAll();
      showToast(`已恢复「${task.title}」原定日期 (${dateLabel(occurrenceKey)})`);
    } catch (e) {
      showToast(`恢复失败：${String(e)}`);
    }
  }

  async function handleUploadAttachment(task: Task, localPath: string) {
    try {
      const updated = await api.uploadTaskAttachment(task.id, localPath);
      applyLocalTaskPatch(task.id, () => updated);
      await refreshAll();
      const name = localPath.split(/[\\/]/).pop() ?? localPath;
      showToast(`已上传附件「${name}」`);
    } catch (e) {
      showToast(`附件上传失败：${String(e)}`);
    }
  }

  async function handleDownloadAttachment(task: Task, att: TaskAttachment, localDest: string) {
    try {
      await api.downloadTaskAttachment(task.id, att.file_id, localDest);
      showToast(`已保存附件「${att.name}」`);
    } catch (e) {
      showToast(`附件下载失败：${String(e)}`);
    }
  }

  async function handleRemoveAttachment(task: Task, fileId: string) {
    try {
      const updated = await api.removeTaskAttachment(task.id, fileId);
      applyLocalTaskPatch(task.id, () => updated);
      await refreshAll();
      showToast("已从待办移除附件");
    } catch (e) {
      showToast(`移除附件失败：${String(e)}`);
    }
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
        ).sort(([a], [b]) => (a === "未安排" ? 1 : b === "未安排" ? -1 : a.localeCompare(b)))
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
    if (task.repeat && task.series) {
      if (!date) {
        showToast("重复任务不支持清除单期日期，请在详情面板关闭重复");
        return;
      }
      const key = task.effective_current_key ?? task.series.cursor;
      const allDay = task.schedule.all_day || !task.schedule.due?.time;
      const dueTime = allDay ? null : task.schedule.due?.time ?? null;
      await api.overrideOccurrence(task.id, key, date, dueTime, allDay, null);
      await refreshAll();
      showToast(`已调整本期到 ${dateLabel(date)}`);
      return;
    }
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

  async function handlePostponeAllOverdue() {
    if (postponing || overdueToday.length === 0) return;
    setPostponing(true);
    const snapshot = [...overdueToday];
    const target = todayStr();
    const now = new Date();
    let okCount = 0;
    try {
      for (const t of snapshot) {
        try {
          const rawTime = t.schedule.all_day ? null : t.schedule.due?.time ?? null;
          const timePassedToday = Boolean(rawTime && new Date(`${target}T${rawTime}`) <= now);
          const effectiveAllDay = t.schedule.all_day || !rawTime || timePassedToday;
          const effectiveTime = effectiveAllDay ? null : rawTime;
          if (t.repeat && t.series) {
            await api.overrideOccurrence(
              t.id,
              t.effective_current_key ?? t.series.cursor,
              target,
              effectiveTime,
              effectiveAllDay,
              null
            );
          } else {
            await api.updateTask(t.id, {
              schedule: {
                ...t.schedule,
                all_day: effectiveAllDay,
                due: {
                  date: target,
                  time: effectiveTime,
                },
              },
              etag: t.etag,
            });
          }
          okCount++;
        } catch {
          // Continue remaining overdue items
        }
      }
      await refreshAll();
      if (okCount === snapshot.length) {
        showToast(`已将 ${okCount} 条逾期任务顺延到今天`);
      } else {
        showToast(`已顺延 ${okCount}/${snapshot.length} 条逾期任务到今天`);
      }
    } finally {
      setPostponing(false);
    }
  }

  // Global keyboard shortcuts (Dida365-style)
  useEffect(() => {
    if (!auth?.logged_in) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing = Boolean(
        target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable)
      );
      const hasDialog = Boolean(
        ctxMenu || showSettings || document.querySelector('[role="dialog"], .fixed.z-50')
      );
      const mod = e.metaKey || e.ctrlKey;
      const noMods = !e.ctrlKey && !e.metaKey && !e.altKey;

      if (mod && e.key.toLowerCase() === "k" && !hasDialog) {
        e.preventDefault();
        setWorkspace("tasks");
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !editing && !hasDialog) {
        const idx = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7"].indexOf(
          e.code
        );
        if (idx >= 0) {
          e.preventDefault();
          const modEntry = TOOLBOX_MODULES[idx];
          if (modEntry) setWorkspace(modEntry.id);
          return;
        }
      }
      if (e.key === "Escape") {
        if (ctxMenu) {
          setCtxMenu(null);
          return;
        }
        if (showSettings) return;
        if (document.querySelector('[role="dialog"], .fixed.z-50')) return;
        if (editing) {
          target?.blur();
          return;
        }
        if (query) {
          setQuery("");
          return;
        }
        if (selectedId !== null) setSelectedId(null);
        return;
      }
      if (editing || hasDialog || workspace !== "tasks") return;

      if (e.key === "/" && noMods) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key.toLowerCase() === "n" && noMods && !e.shiftKey) {
        e.preventDefault();
        requestAnimationFrame(() => quickAddRef.current?.focus());
      } else if ((e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") && noMods) {
        const map: Record<string, TaskView> = {
          "1": "today",
          "2": "upcoming",
          "3": "inbox",
          "4": "all",
        };
        setActiveList(null);
        setActiveLabel(null);
        setView(map[e.key]);
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && noMods) {
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
      } else if (selected && ((e.key === " " && noMods) || (mod && e.key === "Enter"))) {
        e.preventDefault();
        void handleToggle(selected);
      } else if (selected && (e.key === "Delete" || e.key === "Backspace") && noMods) {
        e.preventDefault();
        if (window.confirm(`确定删除「${selected.title}」吗？`)) {
          void handleDelete(selected);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [auth?.logged_in, workspace, selectedId, selected, visibleTaskOrder, ctxMenu, showSettings, query]);
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

  const groupHeader = (
    label: React.ReactNode,
    tone: "default" | "danger" = "default",
    action?: React.ReactNode
  ) => (
    <div
      className={`sticky top-0 z-10 flex items-center justify-between bg-white/95 px-2.5 pb-1 pt-3 text-xs font-semibold backdrop-blur ${
        tone === "danger" ? "text-red-500" : "text-slate-500"
      }`}
    >
      <span>{label}</span>
      {action}
    </div>
  );

  return (
    <div className="flex h-screen bg-slate-50">
      {/* ZSpace Kit Modular Toolbox Navigation Rail */}
      <nav className="flex w-14 shrink-0 flex-col items-center border-r border-slate-200 bg-slate-100 py-3 gap-2">
        <div
          title={`ZSpace Kit · 极空工具箱 (${auth.nas_id ?? ""}) · 连接：${
            settings?.connection_mode === "lan"
              ? `LAN 直连 (${settings.lan_host ?? ""})`
              : settings?.connection_mode === "cloud"
              ? "云代理"
              : auth.mode ?? "auto"
          }`}
          className="relative mb-2 flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-[11px] font-bold tracking-tight text-white shadow-xs"
        >
          ZK
          {settings?.connection_mode === "lan" && (
            <span
              title="LAN 内网直连已开启"
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-slate-100"
            />
          )}
        </div>

        {TOOLBOX_MODULES.map((mod) => (
          <button
            key={mod.id}
            type="button"
            title={`${mod.label}（${mod.shortcut}）· ${mod.description}`}
            onClick={() => setWorkspace(mod.id)}
            className={`flex h-10 w-10 flex-col items-center justify-center rounded-xl transition ${
              workspace === mod.id
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-500 hover:bg-slate-200/70"
            }`}
          >
            {mod.icon}
          </button>
        ))}

        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            type="button"
            title={`待办悬浮窗（${settings?.global_shortcut ?? "Ctrl/Cmd+Shift+M"}）`}
            onClick={() => void api.toggleFloatingWindow()}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70"
          >
            <PanelRightOpen className="h-4.5 w-4.5" />
          </button>

          <button
            type="button"
            title={
              updateInfo?.has_update
                ? `设置 · 发现新版本 v${updateInfo.latest_version}`
                : "设置"
            }
            onClick={() => setShowSettings(true)}
            className="relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70"
          >
            <Settings className="h-4.5 w-4.5" />
            {updateInfo?.has_update && (
              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-blue-600 ring-2 ring-slate-100" />
            )}
          </button>
        </div>
      </nav>

      {/* Main Content Area: Toolbox Modules */}
      {workspace !== "tasks" ? (
        <Suspense fallback={<WorkspaceLoadingShell />}>
          {workspace === "sticky" ? (
            <StickyBoard
              onConvertToTodo={handleCreate}
              onToast={(m) => showToast(m)}
            />
          ) : workspace === "files" ? (
            <FileDropView
              settings={settings}
              onSettingsChanged={(cfg) => setSettings(cfg)}
              onToast={(m) => showToast(m)}
            />
          ) : workspace === "nas" ? (
            <NasStatusView
              settings={settings}
              onSettingsChanged={(cfg) => setSettings(cfg)}
              onToast={(m) => showToast(m)}
            />
          ) : workspace === "docker" ? (
            <DockerBoardView onToast={(m) => showToast(m)} />
          ) : workspace === "downloader" ? (
            <DownloaderView settings={settings} onToast={(m) => showToast(m)} />
          ) : workspace === "calendar" ? (
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
                onQuickUpdateTask={async (id, patch) => {
                  await handleUpdate(id, patch);
                }}
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
                    onOverrideOccurrence={handleOverrideOccurrence}
                    onClearOccurrenceOverride={handleClearOccurrenceOverride}
                    onUploadAttachment={handleUploadAttachment}
                    onDownloadAttachment={handleDownloadAttachment}
                    onRemoveAttachment={handleRemoveAttachment}
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
          ) : null}
        </Suspense>
      ) : (
        <div className="flex min-w-0 flex-1">
          {/* Task Views & Custom Lists Sidebar */}
          {!prefs.sidebarCollapsed && (
            <aside className="flex w-[212px] shrink-0 flex-col overflow-y-auto border-r border-slate-200/80 bg-[#fbfbfd] px-2.5 py-3">
              {/* Primary Smart Views: 所有 / 今天 / 最近7天 / 收集箱 */}
              <div className="space-y-0.5">
                {PRIMARY_VIEW_ITEMS.map((item) => {
                  const active = noSubFilter && view === item.key;
                  const count =
                    item.key === "all"
                      ? viewCounts.all
                      : item.key === "today"
                      ? viewCounts.today
                      : item.key === "upcoming"
                      ? viewCounts.upcoming
                      : item.key === "inbox"
                      ? viewCounts.inbox
                      : 0;
                  const label = item.key === "upcoming" ? `最近${upcomingDays}天` : item.label;
                  const todayDay = Number(todayStr().slice(8, 10));
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
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[6px] text-[13.5px] transition ${
                        item.key === "inbox" && dragOverList === "__inbox__"
                          ? "bg-blue-100 ring-1 ring-blue-400"
                          : active
                          ? "bg-[#eef3ff] font-medium text-[#191919]"
                          : "text-[#333333] hover:bg-slate-200/50"
                      }`}
                    >
                      <span className={active ? "text-blue-600" : "text-slate-400"}>
                        {item.icon(todayDay, upcomingDays)}
                      </span>
                      <span className="flex-1 text-left">{label}</span>
                      {count > 0 && (
                        <span className="text-[11.5px] tabular-nums text-slate-400">{count}</span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="my-2.5 border-t border-slate-100" />

              {/* Collapsible Lists */}
              <div>
                <div className="mb-1 flex items-center justify-between px-1.5 text-[11.5px] font-medium text-slate-400">
                  <button
                    type="button"
                    onClick={() => setPrefs({ listsCollapsed: !prefs.listsCollapsed })}
                    className="flex flex-1 items-center gap-1 rounded px-1 py-0.5 text-left transition hover:bg-slate-200/50 hover:text-slate-600"
                  >
                    <ChevronRight
                      className={`h-3 w-3 shrink-0 transition-transform ${
                        prefs.listsCollapsed ? "" : "rotate-90"
                      }`}
                    />
                    <span>清单</span>
                  </button>
                  <button
                    type="button"
                    title="新建清单"
                    onClick={() => {
                      if (prefs.listsCollapsed) setPrefs({ listsCollapsed: false });
                      setAddingList((v) => !v);
                    }}
                    className="rounded p-0.5 transition hover:bg-slate-200/70 hover:text-slate-700"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>

                {addingList && !prefs.listsCollapsed && (
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
                    onBlur={() => {
                      setAddingList(false);
                      setNewListName("");
                    }}
                    placeholder="清单名称，回车确认"
                    className="mb-1.5 w-full rounded-lg border border-blue-400 bg-white px-2.5 py-1 text-xs outline-none"
                  />
                )}

                {!prefs.listsCollapsed && (
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
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-[5.5px] text-[13px] transition ${
                            dragOverList === l
                              ? "bg-blue-100 ring-1 ring-blue-400"
                              : active
                              ? "bg-[#eef3ff] font-medium text-[#191919]"
                              : "text-[#333333] hover:bg-slate-200/50"
                          }`}
                        >
                          <ListIcon
                            className={`h-3.5 w-3.5 shrink-0 ${active ? "text-blue-600" : "text-slate-400"}`}
                            strokeWidth={1.75}
                          />
                          <span className="flex-1 truncate text-left">{l}</span>
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: listColorHex(l) ?? "#4772FA" }}
                          />
                          {(listCounts[l] ?? 0) > 0 && (
                            <span className="min-w-[14px] text-right text-[11.5px] tabular-nums text-slate-400">
                              {listCounts[l]}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Collapsible Labels */}
              {allLabels.length > 0 && (
                <>
                  <div className="my-2.5 border-t border-slate-100" />
                  <div>
                    <button
                      type="button"
                      onClick={() => setPrefs({ labelsCollapsed: !prefs.labelsCollapsed })}
                      className="mb-1 flex w-full items-center gap-1 rounded px-2.5 py-0.5 text-left text-[11.5px] font-medium text-slate-400 transition hover:bg-slate-200/50 hover:text-slate-600"
                    >
                      <ChevronRight
                        className={`h-3 w-3 shrink-0 transition-transform ${
                          prefs.labelsCollapsed ? "" : "rotate-90"
                        }`}
                      />
                      <span>标签</span>
                    </button>
                    {!prefs.labelsCollapsed && (
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
                              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-[5.5px] text-[13px] transition ${
                                active
                                  ? "bg-[#eef3ff] font-medium text-[#191919]"
                                  : "text-[#333333] hover:bg-slate-200/50"
                              }`}
                            >
                              <Tag
                                className={`h-3.5 w-3.5 shrink-0 ${active ? "text-blue-600" : "text-slate-400"}`}
                                strokeWidth={1.75}
                              />
                              <span className="flex-1 truncate text-left">{lb}</span>
                              <span className="text-[11.5px] tabular-nums text-slate-400">
                                {labelCounts[lb]}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Bottom Secondary Utility Views: 已逾期 / 重复任务 / 已完成 */}
              <div className="mt-auto space-y-0.5 border-t border-slate-100 pt-2.5">
                {SECONDARY_VIEW_ITEMS.map((item) => {
                  const active = noSubFilter && view === item.key;
                  const count =
                    item.key === "overdue"
                      ? viewCounts.overdue
                      : item.key === "repeating"
                      ? viewCounts.repeating
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
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[6px] text-[13px] transition ${
                        active
                          ? "bg-[#eef3ff] font-medium text-[#191919]"
                          : "text-[#475569] hover:bg-slate-200/50"
                      }`}
                    >
                      <span
                        className={
                          active
                            ? item.key === "overdue"
                              ? "text-red-500"
                              : "text-blue-600"
                            : item.key === "overdue" && count > 0
                            ? "text-red-400"
                            : "text-slate-400"
                        }
                      >
                        {item.icon}
                      </span>
                      <span className="flex-1 text-left">{item.label}</span>
                      {count > 0 && (
                        <span
                          className={`text-[11.5px] tabular-nums ${
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
            </aside>
          )}

          {/* Middle Task List */}
          <main className="flex min-w-0 flex-1 flex-col border-r border-slate-200/80 bg-white">
            <div className="space-y-2.5 px-4 pb-2 pt-3.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title={prefs.sidebarCollapsed ? "展开左侧栏" : "收起左侧栏"}
                  onClick={() => setPrefs({ sidebarCollapsed: !prefs.sidebarCollapsed })}
                  className="-ml-1 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                >
                  {prefs.sidebarCollapsed ? (
                    <PanelLeftOpen className="h-4 w-4" />
                  ) : (
                    <PanelLeftClose className="h-4 w-4" />
                  )}
                </button>
                <h1 className="text-lg font-semibold tracking-tight text-[#191919]">
                  {activeList ??
                    (activeLabel
                      ? `#${activeLabel}`
                      : view === "upcoming" && upcomingDays !== 7
                      ? `最近${upcomingDays}天`
                      : ALL_VIEW_LABELS[view])}
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
                      {groupHeader(
                        <>
                          已过期 <span className="font-normal">{overdueToday.length}</span>
                        </>,
                        "danger",
                        <button
                          type="button"
                          disabled={postponing}
                          onClick={() => void handlePostponeAllOverdue()}
                          className="text-xs font-medium text-blue-600 transition hover:text-blue-700 hover:underline disabled:opacity-50"
                        >
                          {postponing ? "顺延中…" : "顺延"}
                        </button>
                      )}
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
                          {date === "未安排" ? "未安排日期" : dateLabel(date)}
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
              onOverrideOccurrence={handleOverrideOccurrence}
              onClearOccurrenceOverride={handleClearOccurrenceOverride}
              onUploadAttachment={handleUploadAttachment}
              onDownloadAttachment={handleDownloadAttachment}
              onRemoveAttachment={handleRemoveAttachment}
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
        <Suspense fallback={null}>
          <SettingsModal
            auth={auth}
            updateInfo={updateInfo}
            updateProgress={updateProgress}
            installingUpdate={installingUpdate}
            updateError={updateError}
            onUpdateChecked={(info) => {
              setUpdateInfo(info);
              if (info.has_update) setUpdateDismissed(false);
            }}
            onInstallUpdate={handleInstallUpdate}
            onAuthRefreshed={(nextAuth) => setAuth(nextAuth)}
            onClose={() => {
              if (!installingUpdate) setShowSettings(false);
            }}
            onLogout={async () => {
              await api.logout();
              refreshSeqRef.current++;
              customListsAccountRef.current = null;
              setShowSettings(false);
              setAuth({ logged_in: false, profile: "zspace-memo" });
              setSettings(null);
              setTasks([]);
              setAllActive([]);
              setCompletedTasks([]);
              setCustomLists([]);
              setSelectedId(null);
              setActiveList(null);
              setActiveLabel(null);
              setConflictMsg(null);
              setQuery("");
              setLoaded(false);
              setView("today");
              setWorkspace("tasks");
            }}
            onSettingsChanged={(cfg) => {
              setSettings(cfg);
              void refreshAll();
            }}
          />
        </Suspense>
      )}

      {updateInfo?.has_update && !updateDismissed && !showSettings && (
        <div className="fixed bottom-5 right-5 z-40 w-80 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xl space-y-2.5">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-slate-900">
                发现新版本 v{updateInfo.latest_version}
              </div>
              <div className="text-[11px] text-slate-400">
                当前 v{updateInfo.current_version}
                {(updateInfo.asset_size ?? 0) > 0
                  ? ` · 包体积 ${formatBytesCompact(updateInfo.asset_size)}`
                  : ""}
              </div>
            </div>
            {!installingUpdate && (
              <button
                type="button"
                title="稍后提醒"
                onClick={() => setUpdateDismissed(true)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {updateProgress && installingUpdate ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-blue-700">
                <span className="truncate">{updateProgress.message}</span>
                <span className="shrink-0 tabular-nums">
                  {updateProgress.total
                    ? `${updateProgress.percent}%`
                    : formatBytesCompact(updateProgress.downloaded)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-150"
                  style={{ width: `${Math.max(4, updateProgress.percent)}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              {updateInfo.auto_install_supported && (
                <button
                  type="button"
                  onClick={() => void handleInstallUpdate(updateInfo)}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700"
                >
                  <Download className="h-3.5 w-3.5" />
                  立即应用内更新
                </button>
              )}
              <button
                type="button"
                onClick={() => void openUrl(updateInfo.release_url)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
              >
                发布页
              </button>
            </div>
          )}

          {updateError && (
            <div className="text-[11px] text-red-500">{updateError}</div>
          )}
        </div>
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
