import { useEffect, useState } from "react";
import { api } from "./api";
import type { AuthStatus, OAuthStartInfo, Task, TaskSort, TaskView } from "./types";

const VIEWS: { key: TaskView; label: string }[] = [
  { key: "inbox", label: "收集箱" },
  { key: "today", label: "今天" },
  { key: "upcoming", label: "即将到来" },
  { key: "overdue", label: "已逾期" },
  { key: "all", label: "全部任务" },
  { key: "completed", label: "已完成" },
  { key: "repeating", label: "重复任务" },
];

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [oauth, setOAuth] = useState<OAuthStartInfo | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [view, setView] = useState<TaskView>("today");
  const [sort, setSort] = useState<TaskSort>("date");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [quickTitle, setQuickTitle] = useState("");
  const [statusMsg, setStatusMsg] = useState("就绪");
  const [busy, setBusy] = useState(false);

  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  async function refreshList(v = view, q = query, s = sort) {
    try {
      const list = await api.listTasks(v, q, s);
      setTasks(list);
    } catch (e) {
      setStatusMsg(`加载失败: ${String(e)}`);
    }
  }

  async function init() {
    try {
      const st = await api.authStatus();
      setAuth(st);
      if (st.logged_in) {
        await api.initializeCategory(true);
        await api.syncTasks();
        await refreshList();
      }
    } catch (e) {
      setStatusMsg(String(e));
    }
  }

  useEffect(() => {
    void init();
  }, []);

  useEffect(() => {
    if (auth?.logged_in) {
      void refreshList(view, query, sort);
    }
  }, [view, query, sort, auth?.logged_in]);

  async function handleStartOAuth() {
    setBusy(true);
    try {
      const info = await api.startOAuthLogin();
      setOAuth(info);
      setStatusMsg("请在浏览器完成极空间官方授权，并粘贴一次性授权码");
    } catch (e) {
      setStatusMsg(`发起授权失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitCode() {
    if (!authCode.trim()) return;
    setBusy(true);
    try {
      const st = await api.submitOAuthCode(authCode.trim());
      setAuth(st);
      setOAuth(null);
      setAuthCode("");
      await api.initializeCategory(true);
      await api.syncTasks();
      await refreshList();
      setStatusMsg("授权成功并已同步");
    } catch (e) {
      setStatusMsg(`授权失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleQuickAdd() {
    const title = quickTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      const created = await api.createTask({ title });
      setQuickTitle("");
      setSelectedId(created.id);
      await refreshList();
      setStatusMsg(`已创建「${created.title}」`);
    } catch (e) {
      setStatusMsg(`创建失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(t: Task) {
    setBusy(true);
    try {
      const isDone = t.status === "completed" || t.status === "ended";
      if (isDone) {
        await api.reopenTask(t.id);
      } else {
        await api.completeTask(t.id);
      }
      await refreshList();
    } catch (e) {
      setStatusMsg(`操作失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSync() {
    setBusy(true);
    setStatusMsg("同步中…");
    try {
      const res = await api.syncTasks();
      await refreshList();
      setStatusMsg(`已同步 ${res.total_notes} 条笔记（更新 ${res.fetched_details}）`);
    } catch (e) {
      setStatusMsg(`同步失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!auth?.logged_in) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <h1 className="text-xl font-semibold">ZSpace Memo</h1>
          <p className="text-sm text-slate-600">
            通过极空间官方 OAuth2 授权连接你的原生记事本，不接触、不存储 NAS 账号密码。
          </p>
          {!oauth ? (
            <button
              disabled={busy}
              onClick={handleStartOAuth}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "正在生成授权链接…" : "发起极空间官方授权"}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg bg-slate-100 p-3 text-xs break-all">
                <div className="font-medium mb-1">1. 打开以下链接完成授权（{oauth.expires_in} 秒内有效）：</div>
                <a
                  href={oauth.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 underline"
                >
                  {oauth.url}
                </a>
              </div>
              <input
                type="text"
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
                placeholder="2. 粘贴页面给出的一次性授权码"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                disabled={busy || !authCode.trim()}
                onClick={handleSubmitCode}
                className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                完成登录
              </button>
            </div>
          )}
          <div className="text-xs text-slate-500">{statusMsg}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-semibold">ZSpace Memo</span>
          <span className="text-xs text-emerald-600">● {auth.nas_id ?? "已连接"}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>{statusMsg}</span>
          <button
            disabled={busy}
            onClick={handleSync}
            className="rounded border border-slate-300 px-2.5 py-1 text-slate-700 hover:bg-slate-100"
          >
            同步
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-48 shrink-0 border-r border-slate-200 bg-slate-100/70 p-2 space-y-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`w-full rounded-lg px-3 py-1.5 text-left text-sm ${
                view === v.key
                  ? "bg-blue-50 font-medium text-blue-700"
                  : "text-slate-700 hover:bg-slate-200/60"
              }`}
            >
              {v.label}
            </button>
          ))}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col border-r border-slate-200 bg-white">
          <div className="border-b border-slate-200 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题 / 备注 / 标签"
                className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as TaskSort)}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
              >
                <option value="date">按截止日期</option>
                <option value="priority">按优先级</option>
                <option value="created">按创建时间</option>
              </select>
            </div>
            <div className="flex gap-2">
              <input
                value={quickTitle}
                onChange={(e) => setQuickTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleQuickAdd()}
                placeholder="＋ 快速添加任务，回车写入极空间记事本"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
              <button
                disabled={busy || !quickTitle.trim()}
                onClick={handleQuickAdd}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                添加
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {tasks.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-400">暂无任务</div>
            ) : (
              tasks.map((t) => {
                const done = t.status === "completed" || t.status === "ended";
                return (
                  <div
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-slate-50 ${
                      selectedId === t.id ? "bg-blue-50/70" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={(e) => {
                        e.stopPropagation();
                        void handleToggle(t);
                      }}
                      className="h-4 w-4 rounded-full"
                    />
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-sm ${done ? "line-through text-slate-400" : ""}`}>
                        {t.title}
                      </div>
                      <div className="text-xs text-slate-400 flex gap-2">
                        {t.schedule.due && (
                          <span>
                            {t.schedule.due.date} {t.schedule.due.time ?? ""}
                          </span>
                        )}
                        {t.list && <span>{t.list}</span>}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </main>

        <section className="w-96 shrink-0 overflow-y-auto bg-white p-4">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              选择一个任务查看详情
            </div>
          ) : (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">{selected.title}</h2>
              <div className="text-xs text-slate-500 space-y-1">
                <div>极空间笔记 ID: #{selected.id}</div>
                <div>优先级: {selected.priority}</div>
                <div>
                  截止: {selected.schedule.due ? `${selected.schedule.due.date} ${selected.schedule.due.time ?? ""}` : "无"}
                </div>
                <div>提醒数: {selected.reminders.length}</div>
              </div>
              <div className="rounded-lg border border-slate-200 p-3 text-sm whitespace-pre-wrap">
                {selected.description || "暂无备注"}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
