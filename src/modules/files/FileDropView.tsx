import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  Download,
  File as FileIcon,
  Folder,
  FolderUp,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { AppSettings } from "../../types";

interface Props {
  settings: AppSettings | null;
  onSettingsChanged: (cfg: AppSettings) => void;
  onToast: (msg: string) => void;
}

interface NasEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

interface UploadJob {
  id: string;
  name: string;
  localPath: string;
  destDir: string;
  status: "uploading" | "done" | "error";
  error?: string;
}

function formatBytes(bytes: number): string {
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

function parseBoolFlag(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "dir" || s === "folder";
  }
  return false;
}

function parseEntries(data: Record<string, unknown>, basePath: string): NasEntry[] {
  const candidates = [data.list, data.files, data.items, data.data, data.rows];
  const arr = (candidates.find(Array.isArray) as Record<string, unknown>[] | undefined) ?? [];
  const entries = arr.map((r) => {
    const name = String(r.name ?? r.file_name ?? r.filename ?? "");
    const rawPath = r.path ?? r.file_path ?? r.full_path;
    const path = rawPath ? String(rawPath) : `${basePath.replace(/\/$/, "")}/${name}`;
    const ftype = String(r.ftype ?? r.type ?? "").trim().toLowerCase();
    const hasDirFlag =
      r.is_dir !== undefined ||
      r.isDir !== undefined ||
      r.dir !== undefined ||
      r.is_folder !== undefined ||
      r.isFolder !== undefined;
    const isDir = hasDirFlag
      ? parseBoolFlag(r.is_dir ?? r.isDir ?? r.dir ?? r.is_folder ?? r.isFolder)
      : ftype === "dir" || ftype === "folder";
    const size = Number(r.size ?? r.file_size ?? 0) || 0;
    const mt =
      r.modify_time ?? r.mtime ?? r.updated_at ?? r.update_time ?? r.mod_time ?? r.create_time ?? "";
    const mtime =
      typeof mt === "number" && mt > 0
        ? new Date(mt * (mt > 1e12 ? 1 : 1000)).toLocaleString("zh-CN", { hour12: false })
        : String(mt || "");
    return { name: name || path.split("/").pop() || path, path, isDir, size, mtime };
  });
  return entries.sort(
    (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, "zh-CN")
  );
}

function extractSpaces(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["personal_spaces", "spaces", "device_dirs", "dirs", "list"]) {
    const val = data[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.startsWith("/")) out.push(item);
        else if (item && typeof item === "object") {
          const p = (item as Record<string, unknown>).path ?? (item as Record<string, unknown>).dir;
          if (typeof p === "string" && p.startsWith("/")) out.push(p);
        }
      }
    }
  }
  return Array.from(new Set(out));
}

export function FileDropView({ settings, onSettingsChanged, onToast }: Props) {
  const [lockedDir, setLockedDir] = useState<string>("");
  const [entries, setEntries] = useState<NasEntry[]>([]);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [jobs, setJobs] = useState<UploadJob[]>([]);

  async function loadDir(path: string) {
    if (!path) return;
    setLoading(true);
    setSearchMode(false);
    try {
      const res = await api.nasFileList(path);
      setEntries(parseEntries(res, path));
    } catch (e) {
      onToast(`读取「我的文件/downloads」失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function initDownloadsDir() {
    setLoading(true);
    setSearchMode(false);
    try {
      const res = await api.nasFileSpace();
      const spaces = extractSpaces(res);
      if (spaces.length === 0) {
        onToast("未检测到极空间「个人空间 / 我的文件」根目录");
        return;
      }

      // 1. Fast path: reuse already-resolved `.../downloads` if it lives under one of personal_spaces.
      const saved = settings?.nas_drop_dir?.replace(/\/+$/, "") || "";
      if (saved && /\/downloads$/i.test(saved) && spaces.some((s) => saved.startsWith(`${s.replace(/\/+$/, "")}/`))) {
        try {
          const listRes = await api.nasFileList(saved, 0, 100);
          setLockedDir(saved);
          setEntries(parseEntries(listRes, saved));
          return;
        } catch {
          // Fall through to full discovery across personal spaces.
        }
      }

      // 2. Scan personal spaces to find an existing `downloads` folder (exact lowercase preferred).
      const spaceLists = await Promise.allSettled(spaces.map((s) => api.nasFileList(s, 0, 100)));
      let targetDir = "";
      let ciFallback = "";
      spaces.forEach((space, idx) => {
        const result = spaceLists[idx];
        if (result.status !== "fulfilled") return;
        const items = parseEntries(result.value, space);
        const exact = items.find((item) => item.isDir && item.name === "downloads");
        if (exact && !targetDir) targetDir = exact.path;
        const ci = items.find((item) => item.isDir && item.name.toLowerCase() === "downloads");
        if (ci && !ciFallback) ciFallback = ci.path;
      });

      targetDir = targetDir || ciFallback;

      // 3. Create `我的文件/downloads` on primary personal space if it does not exist yet.
      if (!targetDir) {
        const primary = spaces[0].replace(/\/+$/, "");
        await api.nasMkdir(primary, "downloads");
        targetDir = `${primary}/downloads`;
      }

      setLockedDir(targetDir);
      if (settings && settings.nas_drop_dir !== targetDir) {
        const next = { ...settings, nas_drop_dir: targetDir };
        api
          .saveSettings(next)
          .then(() => onSettingsChanged(next))
          .catch(() => {});
      }
      const listRes = await api.nasFileList(targetDir, 0, 100);
      setEntries(parseEntries(listRes, targetDir));
    } catch (e) {
      onToast(`定位「我的文件/downloads」失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void initDownloadsDir();
  }, []);

  // Listen to native OS drag-drop onto this window when FileDropView is mounted
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "enter" || ev.payload.type === "over") {
        setDragOver(true);
      } else if (ev.payload.type === "leave") {
        setDragOver(false);
      } else if (ev.payload.type === "drop") {
        setDragOver(false);
        if (ev.payload.paths.length > 0) {
          void enqueueUploads(ev.payload.paths);
        }
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [lockedDir]);

  async function enqueueUploads(paths: string[]) {
    if (!lockedDir) {
      onToast("正在定位「我的文件/downloads」目录，请稍后再试");
      return;
    }
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() || p;
      const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setJobs((prev) => [
        { id: jobId, name, localPath: p, destDir: "我的文件/downloads", status: "uploading" },
        ...prev.slice(0, 19),
      ]);
      try {
        await api.nasUploadFile(p, lockedDir, true);
        setJobs((prev) =>
          prev.map((j) => (j.id === jobId ? { ...j, status: "done" } : j))
        );
      } catch (e) {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId ? { ...j, status: "error", error: String(e) } : j
          )
        );
      }
    }
    void loadDir(lockedDir);
  }

  async function handlePickUpload() {
    if (!lockedDir) {
      onToast("正在定位「我的文件/downloads」目录，请稍候");
      return;
    }
    const picked = await open({ multiple: true, directory: false });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    if (list.length > 0) {
      await enqueueUploads(list);
    }
  }

  async function handleDownload(entry: NasEntry) {
    const localDest = await save({ defaultPath: entry.name });
    if (!localDest) return;
    onToast(`正在下载「${entry.name}」…`);
    try {
      await api.nasDownloadFile(entry.path, localDest);
      onToast(`已下载到 ${localDest}`);
    } catch (e) {
      onToast(`下载失败：${String(e)}`);
    }
  }

  async function handleSearch() {
    const q = query.trim();
    if (!q) {
      if (lockedDir) void loadDir(lockedDir);
      return;
    }
    if (!lockedDir) return;
    setLoading(true);
    setSearchMode(true);
    try {
      const res = await api.nasSearchFiles(q, lockedDir);
      setEntries(parseEntries(res, lockedDir));
    } catch (e) {
      onToast(`搜索失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">文件快传箱</h1>
          <p className="text-[11px] text-slate-400">
            专用中转目录，固定收发于极空间「个人空间 / 我的文件/downloads」
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg bg-slate-100/90 px-2.5 py-1 focus-within:bg-white focus-within:ring-1 focus-within:ring-blue-400">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
              placeholder="搜索 downloads 内文件，回车"
              className="w-48 bg-transparent text-xs outline-none placeholder:text-slate-400"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  if (lockedDir) void loadDir(lockedDir);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => (lockedDir ? void loadDir(lockedDir) : void initDownloadsDir())}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin text-blue-500" : ""}`} />
            刷新
          </button>

          <button
            type="button"
            onClick={() => void handlePickUpload()}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Upload className="h-3.5 w-3.5" />
            选择文件上传
          </button>
        </div>
      </div>

      {/* Drop Zone + Locked Directory Indicator */}
      <div className="border-b border-slate-100 bg-slate-50/60 px-5 py-3 space-y-2">
        <div
          onClick={() => void handlePickUpload()}
          className={`flex cursor-pointer items-center justify-center gap-3 rounded-xl border-2 border-dashed py-4 transition ${
            dragOver
              ? "border-blue-500 bg-blue-50 text-blue-700"
              : "border-slate-300/80 bg-white text-slate-500 hover:border-blue-400 hover:bg-blue-50/30"
          }`}
        >
          <FolderUp className="h-5 w-5 text-blue-600" />
          <div className="text-xs">
            <span className="font-medium text-slate-700">把电脑上的文件拖到这里</span>
            <span className="text-slate-400">（或点击选择文件），将直接上传至：</span>
            <code className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-blue-600">
              我的文件/downloads
            </code>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <div className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-blue-600" />
            <span>固定目录：个人空间 · 我的文件/downloads</span>
            {lockedDir && (
              <code
                title={lockedDir}
                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
              >
                {lockedDir}
              </code>
            )}
          </div>
          <span className="text-[11px] text-slate-400">
            {entries.some((e) => e.isDir)
              ? `${entries.filter((e) => e.isDir).length} 个目录 · ${
                  entries.filter((e) => !e.isDir).length
                } 个文件`
              : `共 ${entries.length} 个文件`}
          </span>
        </div>
      </div>

      {/* Recent Upload Queue */}
      {jobs.length > 0 && (
        <div className="border-b border-slate-100 bg-white px-5 py-2 space-y-1">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
            <span>本次传输记录</span>
            <button type="button" onClick={() => setJobs([])} className="hover:text-slate-600">
              清空
            </button>
          </div>
          <div className="max-h-24 space-y-1 overflow-y-auto">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center gap-2 text-xs">
                {j.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
                ) : j.status === "done" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-red-500" />
                )}
                <span className="truncate font-medium text-slate-700">{j.name}</span>
                <span className="truncate text-[11px] text-slate-400">→ {j.destDir}</span>
                {j.error && <span className="ml-auto text-[11px] text-red-500">{j.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* File List */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {searchMode && (
          <div className="mb-2 flex items-center justify-between px-2 text-xs text-blue-600">
            <span>在「我的文件/downloads」中搜索「{query}」的结果（共 {entries.length} 项）</span>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                if (lockedDir) void loadDir(lockedDir);
              }}
              className="hover:underline"
            >
              返回目录列表
            </button>
          </div>
        )}
        {entries.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">
            {loading
              ? "正在加载「我的文件/downloads」…"
              : searchMode
              ? "未找到匹配的文件"
              : "「我的文件/downloads」目录为空"}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm hover:bg-slate-50"
              >
                {entry.isDir ? (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-500">
                    <Folder className="h-3.5 w-3.5" />
                  </span>
                ) : (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500">
                    <FileIcon className="h-3.5 w-3.5" />
                  </span>
                )}
                <span
                  className={`min-w-0 flex-1 truncate ${
                    entry.isDir ? "font-medium text-slate-800" : "text-slate-700"
                  }`}
                >
                  {entry.name}
                  {entry.isDir && (
                    <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      目录
                    </span>
                  )}
                </span>
                <span className="w-20 text-right text-xs tabular-nums text-slate-400">
                  {entry.isDir ? "—" : formatBytes(entry.size)}
                </span>
                <span className="hidden w-36 text-right text-[11px] text-slate-400 md:inline">
                  {entry.mtime}
                </span>
                <div className="flex w-16 shrink-0 justify-end">
                  {!entry.isDir && (
                    <button
                      type="button"
                      title="下载到本地"
                      onClick={() => void handleDownload(entry)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600"
                    >
                      <Download className="h-3 w-3" />
                      下载
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
