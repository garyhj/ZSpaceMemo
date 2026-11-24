import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  Bell,
  Calendar,
  CalendarClock,
  CheckCircle2,
  Folder,
  Inbox,
  Layers,
  PanelRightOpen,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { AuthScreen } from "./components/AuthScreen";
import { FloatingWindow } from "./components/FloatingWindow";
import { NotificationDrawer } from "./components/NotificationDrawer";
import { QuickAddBar } from "./components/QuickAddBar";
import { SettingsModal } from "./components/SettingsModal";
import { TaskDetail } from "./components/TaskDetail";
import { TaskListItem } from "./components/TaskListItem";
import type {
  AppSettings,
  AuthStatus,
  CreateTaskInput,
  NotificationRecord,
  Task,
  TaskSort,
  TaskView,
  UpdateTaskInput,
} from "./types";
import { dateLabel, effectiveDue, isTaskOverdue, todayStr } from "./utils/date";

const VIEW_ITEMS: { key: TaskView; label: string; icon: React.ReactNode }[] = [
  { key: "inbox", label: "收集箱", icon: <Inbox className="h-4 w-4" /> },
  { key: "today", label: "今天", icon: <Sun className="h-4 w-4" /> },
  { key: "upcoming", label: "即将到来", icon: <CalendarClock className="h-4 w-4" /> },
  { key: "overdue", label: "已逾期", icon: <AlertCircle className="h-4 w-4" /> },
  { key: "all", label: "全部任务", icon: <Layers className="h-4 w-4" /> },
  { key: "completed", label: "已完成", icon: <CheckCircle2 className="h-4 w-4" /> },
  { key: "repeating", label: "重复任务", icon: <Repeat className="h-4 w-4" /> },
];

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
  const [view, setView] = useState<TaskView>("today");
  const [sort, setSort] = useState<TaskSort>("date");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [allActive, setAllActive] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? allActive.find((t) => t.id === selectedId) ?? null,
    [tasks, allActive, selectedId]
  );

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const lists = useMemo(() => {
    const set = new Set<string>();
    for (const t of allActive) {
      if (t.list) set.add(t.list);
    }
    return Array.from(set).sort();
  }, [allActive]);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 3500);
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
      setSelectedId(ev.payload);
      setView("all");
    });

    return () => {
      void unSynced.then((f) => f());
      void unFired.then((f) => f());
      void unSelect.then((f) => f());
    };
  }, []);

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
      const created = await api.createTask(input);
      setSelectedId(created.id);
      await refreshAll();
      showToast(`已创建「${created.title}」（笔记 #${created.id}）`);
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
        showToast(`已重新打开「${task.title}」`);
      } else {
        const updated = await api.completeTask(task.id);
        if (updated.repeat && updated.series && updated.status === "active") {
          showToast(`已完成本次 · 下次 ${dateLabel(updated.series.cursor)}`);
        } else {
          showToast(`已完成「${task.title}」`);
        }
      }
      await refreshAll();
    } catch (e) {
      showToast(`操作失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip(task: Task, key?: string) {
    setBusy(true);
    try {
      const updated = await api.skipOccurrence(task.id, key);
      await refreshAll();
      showToast(
        updated.series
          ? `已跳过本次 · 下次 ${dateLabel(updated.series.cursor)}`
          : "已跳过本次"
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

  const overdueToday = view === "today" ? tasks.filter(isTaskOverdue) : [];
  const normalToday = view === "today" ? tasks.filter((t) => !isTaskOverdue(t)) : tasks;

  // Group Upcoming view by date.
  const upcomingGroups =
    view === "upcoming"
      ? Object.entries(
          tasks.reduce<Record<string, Task[]>>((acc, t) => {
            const d = effectiveDue(t)?.date ?? "未安排";
            (acc[d] ??= []).push(t);
            return acc;
          }, {})
        ).sort(([a], [b]) => a.localeCompare(b))
      : [];

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm">ZSpace Memo</span>
          <span className="text-xs text-emerald-600">● {auth.nas_id ?? "已连接"}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            title="切换快捷悬浮窗（Ctrl/Cmd+Shift+M）"
            onClick={() => void api.toggleFloatingWindow()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
            悬浮窗
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSync()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
            同步
          </button>
          <button
            type="button"
            title="通知中心"
            onClick={() => setShowNotif(true)}
            className="relative rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
                {unreadCount}
              </span>
            )}
          </button>
          <button
            type="button"
            title="设置"
            onClick={() => setShowSettings(true)}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left Sidebar */}
        <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-slate-100/70 p-2.5 overflow-y-auto">
          <nav className="space-y-0.5">
            {VIEW_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setView(item.key)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition ${
                  view === item.key
                    ? "bg-blue-50 font-medium text-blue-700"
                    : "text-slate-700 hover:bg-slate-200/60"
                }`}
              >
                <span className={view === item.key ? "text-blue-600" : "text-slate-400"}>
                  {item.icon}
                </span>
                <span className="flex-1 text-left">{item.label}</span>
              </button>
            ))}
          </nav>

          {lists.length > 0 && (
            <div className="mt-5">
              <div className="mb-1 px-2.5 text-[11px] font-medium text-slate-400">清单</div>
              <div className="space-y-0.5">
                {lists.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => {
                      setView("all");
                      setQuery(l);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200/60"
                  >
                    <Folder className="h-3.5 w-3.5 text-slate-400" />
                    <span className="truncate">{l}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Middle Task List */}
        <main className="flex min-w-0 flex-1 flex-col border-r border-slate-200 bg-white">
          <div className="border-b border-slate-200 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-slate-900">
                {VIEW_ITEMS.find((v) => v.key === view)?.label}
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
            </div>

            <QuickAddBar busy={busy} onCreate={handleCreate} />
          </div>

          <div className="flex-1 overflow-y-auto">
            {view === "today" ? (
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
            ) : view === "upcoming" ? (
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
            ) : tasks.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">暂无任务</div>
            ) : (
              tasks.map((t) => (
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
        <section className="w-[410px] shrink-0 bg-white">
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
            setSelectedId(id);
            setView("all");
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-slate-200 bg-slate-900 px-4 py-2 text-xs text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
