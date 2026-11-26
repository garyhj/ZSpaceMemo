import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  Code2,
  Copy,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import type { AppSettings } from "../../types";

interface Props {
  settings: AppSettings | null;
  onToast: (msg: string) => void;
}

type DlStatusGroup = "loading" | "paused" | "complete" | "error";

interface DownloadTaskItem {
  id: string | number;
  idKey: string;
  name: string;
  size: number;
  completedSize: number;
  progress: number;
  downSpeed: number;
  upSpeed: number;
  statusGroup: DlStatusGroup;
  statusText: string;
  dir: string;
  errorMsg?: string;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numVal(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "0 B/s";
  return `${fmtBytes(bytesPerSec)}/s`;
}

function extractTaskObjects(root: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  const arrayKeys = ["list", "tasks", "items", "rows", "details", "data", "torrents"];
  const objKeys = ["control", "tasks", "data", "result", "summary"];

  while (queue.length > 0 && found.length < 400) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      for (const item of cur) {
        const o = asObj(item);
        if (o) found.push(o);
      }
      continue;
    }

    const o = asObj(cur);
    if (!o) continue;
    for (const k of arrayKeys) {
      if (Array.isArray(o[k])) {
        queue.push(o[k]);
      }
    }
    for (const k of objKeys) {
      if (asObj(o[k])) {
        queue.push(o[k]);
      }
    }
  }
  return found;
}

function classifyStatus(r: Record<string, unknown>, progress: number): {
  group: DlStatusGroup;
  text: string;
} {
  const errMsg = String(r.err_msg ?? r.error_msg ?? r.fail_reason ?? "").trim();
  const raw = r.status ?? r.state ?? r.task_status ?? r.download_status ?? "";
  const rawStr = String(raw).trim().toLowerCase();

  if (errMsg || rawStr.includes("err") || rawStr.includes("fail") || raw === 5 || raw === -1) {
    return { group: "error", text: errMsg ? "异常" : "下载失败" };
  }
  if (
    rawStr === "complete" ||
    rawStr === "completed" ||
    rawStr === "finished" ||
    rawStr === "done" ||
    rawStr === "seeding" ||
    rawStr === "seed" ||
    raw === 2 ||
    raw === 6 ||
    (progress >= 100 && !rawStr.includes("pause") && !rawStr.includes("stop"))
  ) {
    return {
      group: "complete",
      text: rawStr.includes("seed") ? "做种中" : "已完成",
    };
  }
  if (
    rawStr.includes("pause") ||
    rawStr.includes("stop") ||
    rawStr === "stopped" ||
    raw === 0 ||
    raw === 3
  ) {
    return { group: "paused", text: "已暂停" };
  }
  if (rawStr.includes("wait") || rawStr.includes("queue")) {
    return { group: "loading", text: "排队中" };
  }
  return { group: "loading", text: "下载中" };
}

function parseDownloadTasks(payload: Record<string, unknown>): DownloadTaskItem[] {
  const objs = extractTaskObjects(payload);
  const byId = new Map<string, DownloadTaskItem>();

  for (const r of objs) {
    const rawId = r.id ?? r.task_id ?? r.tid ?? r.hash ?? r.gid;
    if (rawId === undefined || rawId === null || String(rawId).trim() === "") continue;
    const id: string | number =
      typeof rawId === "number" ? rawId : /^\d+$/.test(String(rawId).trim()) ? Number(rawId) : String(rawId);
    const idKey = String(id);

    const name = String(
      r.name ?? r.title ?? r.task_name ?? r.filename ?? r.uri ?? r.url ?? `任务 #${idKey}`
    ).trim();
    const size = numVal(r.total_size ?? r.size ?? r.total_length ?? r.file_size);
    const completedSize = numVal(
      r.completed_size ?? r.download_size ?? r.downloaded ?? r.finished_size ?? r.have_size
    );
    let progress = numVal(r.progress ?? r.percent ?? r.ratio);
    if (progress > 0 && progress <= 1 && size > 0 && r.ratio !== undefined) {
      progress = progress * 100;
    } else if (progress === 0 && size > 0 && completedSize > 0) {
      progress = (completedSize / size) * 100;
    }
    progress = Math.max(0, Math.min(100, Math.round(progress * 10) / 10));

    const downSpeed = numVal(
      r.download_speed ?? r.speed ?? r.dl_speed ?? r.down_speed ?? r.rateDownload
    );
    const upSpeed = numVal(r.upload_speed ?? r.up_speed ?? r.rateUpload);
    const dir = String(r.save_path ?? r.dir ?? r.download_dir ?? r.path ?? "").trim();
    const errorMsg = String(r.err_msg ?? r.error_msg ?? r.fail_reason ?? "").trim() || undefined;
    const { group, text } = classifyStatus(r, progress);

    const item: DownloadTaskItem = {
      id,
      idKey,
      name,
      size,
      completedSize,
      progress,
      downSpeed,
      upSpeed,
      statusGroup: group,
      statusText: text,
      dir,
      errorMsg,
    };

    const prev = byId.get(idKey);
    if (!prev || (!prev.size && item.size) || (!prev.dir && item.dir)) {
      byId.set(idKey, item);
    }
  }

  return Array.from(byId.values());
}

function extractDownloadDirs(payload: unknown): string[] {
  const out: string[] = [];
  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();
  while (queue.length > 0 && out.length < 30) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (typeof cur === "string" && cur.startsWith("/")) {
      out.push(cur);
    } else if (Array.isArray(cur)) {
      cur.forEach((v) => queue.push(v));
    } else {
      const o = asObj(cur);
      if (o) {
        for (const k of ["downloaddir", "download_dir", "dir", "path", "save_path"]) {
          const v = o[k];
          if (typeof v === "string" && v.startsWith("/")) out.push(v);
        }
        for (const v of Object.values(o)) {
          if (typeof v === "string" && v.startsWith("/")) out.push(v);
          else if (v && typeof v === "object") queue.push(v);
        }
      }
    }
  }
  return Array.from(new Set(out));
}

export function DownloaderView({ settings, onToast }: Props) {
  const [tasks, setTasks] = useState<DownloadTaskItem[]>([]);
  const [rawJson, setRawJson] = useState<Record<string, unknown> | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);

  const [tab, setTab] = useState<"all" | "loading" | "complete">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [uriInput, setUriInput] = useState("");
  const [dirInput, setDirInput] = useState(settings?.nas_drop_dir ?? "");
  const [dirOptions, setDirOptions] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const refreshSeqRef = useRef(0);

  async function refresh(silent = false) {
    const reqSeq = ++refreshSeqRef.current;
    if (!silent) setLoading(true);
    try {
      const res = await api.nasDownloadTasks(tab, 0, 100);
      if (reqSeq !== refreshSeqRef.current) return;
      setRawJson(res);
      setTasks(parseDownloadTasks(res));
    } catch (e) {
      if (reqSeq !== refreshSeqRef.current) return;
      if (!silent) onToast(`获取下载任务失败：${String(e)}`);
    } finally {
      if (!silent && reqSeq === refreshSeqRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [tab]);

  useEffect(() => {
    api
      .nasDownloadDirs()
      .then((res) => {
        const dirs = extractDownloadDirs(res);
        if (settings?.nas_drop_dir && !dirs.includes(settings.nas_drop_dir)) {
          dirs.push(settings.nas_drop_dir);
        }
        setDirOptions(dirs);
        if (!dirInput && dirs[0]) setDirInput(dirs[0]);
      })
      .catch(() => {
        if (settings?.nas_drop_dir) {
          setDirOptions([settings.nas_drop_dir]);
          if (!dirInput) setDirInput(settings.nas_drop_dir);
        }
      });
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    let cancelled = false;
    let timer: number | undefined;

    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        void (async () => {
          await refresh(true);
          schedule();
        })();
      }, 5000);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [autoRefresh, tab]);

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    const cleanUri = uriInput.trim();
    if (!cleanUri) return;
    setAdding(true);
    try {
      await api.nasDownloadAdd(cleanUri, dirInput.trim() || null);
      onToast("已提交至极空间 NAS 下载器");
      setUriInput("");
      setShowAdd(false);
      await refresh();
    } catch (err) {
      onToast(`创建下载任务失败：${String(err)}`);
    } finally {
      setAdding(false);
    }
  }

  async function handleTaskAction(item: DownloadTaskItem, action: "start" | "stop" | "delete") {
    const zh = action === "start" ? "继续" : action === "stop" ? "暂停" : "删除";
    if (action === "delete" && !window.confirm(`确定从 NAS 下载器删除「${item.name}」吗？`)) return;
    setActingId(item.idKey);
    try {
      await api.nasDownloadAction(action, [item.id]);
      onToast(`已${zh}「${item.name}」`);
      await refresh();
    } catch (err) {
      onToast(`${zh}失败：${String(err)}`);
    } finally {
      setActingId(null);
    }
  }

  async function copyRawJson() {
    if (!rawJson) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(rawJson, null, 2));
      setCopiedRaw(true);
      onToast("已复制下载器原始 JSON");
      window.setTimeout(() => setCopiedRaw(false), 1600);
    } catch (err) {
      onToast(`复制失败：${String(err)}`);
    }
  }

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return tasks
      .filter((t) =>
        tab === "loading"
          ? t.statusGroup === "loading" || t.statusGroup === "paused" || t.statusGroup === "error"
          : tab === "complete"
          ? t.statusGroup === "complete"
          : true
      )
      .filter((t) =>
        !kw ? true : t.name.toLowerCase().includes(kw) || t.dir.toLowerCase().includes(kw)
      );
  }, [tasks, tab, query]);

  const totalDownSpeed = useMemo(
    () => tasks.reduce((sum, t) => sum + t.downSpeed, 0),
    [tasks]
  );
  const totalUpSpeed = useMemo(
    () => tasks.reduce((sum, t) => sum + t.upSpeed, 0),
    [tasks]
  );
  const activeCount = useMemo(
    () => tasks.filter((t) => t.statusGroup === "loading").length,
    [tasks]
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">NAS 下载器</h1>
          <p className="text-[11px] text-slate-400">
            共 {tasks.length} 个任务 · {activeCount} 个下载中 · ↓ {fmtSpeed(totalDownSpeed)} · ↑{" "}
            {fmtSpeed(totalUpSpeed)}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
            {(
              [
                ["all", "全部"],
                ["loading", "进行中"],
                ["complete", "已完成"],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`rounded-md px-2.5 py-1 ${
                  tab === k ? "bg-white font-medium text-blue-600 shadow-2xs" : "text-slate-500"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 rounded-lg bg-slate-100/90 px-2.5 py-1 focus-within:bg-white focus-within:ring-1 focus-within:ring-blue-400">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选文件名或目录"
              className="w-36 bg-transparent text-xs outline-none placeholder:text-slate-400"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} className="text-slate-400 hover:text-slate-600">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-blue-600"
            />
            5秒刷新
          </label>

          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs ${
              showRaw
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            原始数据
          </button>

          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
          >
            <Plus className="h-3.5 w-3.5" />
            新建链接
          </button>

          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
      </div>

      {showAdd && (
        <form
          onSubmit={handleAddTask}
          className="border-b border-slate-200 bg-blue-50/40 px-5 py-3.5 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-800">添加 NAS 远程下载任务</span>
            <span className="text-[11px] text-amber-700">
              将由极空间 NAS 直接发起外部下载连接（自动附带 CLI `--yes --allow-nas-fetch`）
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              value={uriInput}
              onChange={(e) => setUriInput(e.target.value)}
              placeholder="粘贴 HTTP(S) / Magnet 磁力链 / ed2k 链接…"
              className="sm:col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-blue-400"
            />
            <div className="flex gap-1.5">
              <input
                list="zsm-dl-dir-list"
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                placeholder="NAS 保存目录（可留空使用默认）"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-blue-400"
              />
              {dirOptions.length > 0 && (
                <datalist id="zsm-dl-dir-list">
                  {dirOptions.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              )}
              <button
                type="submit"
                disabled={adding || !uriInput.trim()}
                className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {adding ? "提交中…" : "开始下载"}
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="flex-1 overflow-y-auto bg-slate-50/50 p-5 space-y-4">
        {showRaw && rawJson && (
          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                `download control` / `download tasks` 原始响应
              </span>
              <button
                type="button"
                onClick={() => void copyRawJson()}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
              >
                {copiedRaw ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                {copiedRaw ? "已复制" : "复制 JSON"}
              </button>
            </div>
            <pre className="max-h-56 overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-[11px] text-slate-100 select-text">
              {JSON.stringify(rawJson, null, 2)}
            </pre>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 text-slate-400">
            <ArrowDownToLine className="h-10 w-10 text-slate-200" strokeWidth={1.5} />
            <span className="text-sm">{loading ? "正在读取下载任务…" : "当前没有匹配的下载任务"}</span>
            {rawJson && Boolean((rawJson as Record<string, unknown>).control_error || (rawJson as Record<string, unknown>).list_error) && (
              <span className="max-w-md text-center text-[11px] text-amber-600">
                部分接口返回提示：{String((rawJson as Record<string, unknown>).control_error ?? (rawJson as Record<string, unknown>).list_error)}
              </span>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            {filtered.map((item) => {
              const busy = actingId === item.idKey;
              const tone =
                item.statusGroup === "complete"
                  ? "bg-emerald-50 text-emerald-700"
                  : item.statusGroup === "error"
                  ? "bg-red-50 text-red-600"
                  : item.statusGroup === "paused"
                  ? "bg-slate-100 text-slate-600"
                  : "bg-blue-50 text-blue-700";

              return (
                <div
                  key={item.idKey}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs space-y-2.5"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-900">
                          {item.name}
                        </span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
                          {item.statusText}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 tabular-nums">
                        <span>
                          {item.size > 0
                            ? `${fmtBytes(item.completedSize)} / ${fmtBytes(item.size)} (${item.progress}%)`
                            : `${item.progress}%`}
                        </span>
                        {item.downSpeed > 0 && (
                          <span className="text-blue-600">↓ {fmtSpeed(item.downSpeed)}</span>
                        )}
                        {item.upSpeed > 0 && (
                          <span className="text-emerald-600">↑ {fmtSpeed(item.upSpeed)}</span>
                        )}
                        {item.dir && <span className="truncate font-mono text-slate-400">{item.dir}</span>}
                      </div>

                      {item.errorMsg && (
                        <div className="inline-flex items-center gap-1 text-[11px] text-red-600">
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          <span>{item.errorMsg}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5 text-xs">
                      {item.statusGroup === "paused" || item.statusGroup === "error" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleTaskAction(item, "start")}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-white hover:bg-emerald-700 disabled:opacity-40"
                        >
                          <Play className="h-3 w-3" />
                          继续
                        </button>
                      ) : item.statusGroup === "loading" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleTaskAction(item, "stop")}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          <Pause className="h-3 w-3" />
                          暂停
                        </button>
                      ) : null}

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleTaskAction(item, "delete")}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50 disabled:opacity-40"
                      >
                        <Trash2 className="h-3 w-3" />
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        item.statusGroup === "complete"
                          ? "bg-emerald-500"
                          : item.statusGroup === "error"
                          ? "bg-red-500"
                          : item.statusGroup === "paused"
                          ? "bg-slate-400"
                          : "bg-blue-600"
                      }`}
                      style={{ width: `${Math.max(2, item.progress)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
