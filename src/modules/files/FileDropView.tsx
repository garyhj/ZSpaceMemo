import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  Home,
  Loader2,
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

function parseEntries(data: Record<string, unknown>, basePath: string): NasEntry[] {
  const candidates = [data.list, data.files, data.items, data.data, data.rows];
  const arr = (candidates.find(Array.isArray) as Record<string, unknown>[] | undefined) ?? [];
  return arr.map((r) => {
    const name = String(r.name ?? r.file_name ?? r.filename ?? "");
    const rawPath = r.path ?? r.file_path ?? r.full_path;
    const path = rawPath
      ? String(rawPath)
      : `${basePath.replace(/\/$/, "")}/${name}`;
    const ftype = String(r.ftype ?? r.type ?? "");
    const isDir =
      Boolean(r.is_dir ?? r.isDir ?? r.dir) ||
      ftype === "dir" ||
      ftype === "folder" ||
      ftype === "1";
    const size = Number(r.size ?? r.file_size ?? 0) || 0;
    const mt = r.mtime ?? r.updated_at ?? r.update_time ?? r.mod_time ?? "";
    const mtime =
      typeof mt === "number" && mt > 0
        ? new Date(mt * (mt > 1e12 ? 1 : 1000)).toLocaleString("zh-CN", { hour12: false })
        : String(mt || "");
    return { name: name || path.split("/").pop() || path, path, isDir, size, mtime };
  });
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
  const [spaces, setSpaces] = useState<string[]>([]);
  const [currentDir, setCurrentDir] = useState<string>(settings?.nas_drop_dir || "");
  const [entries, setEntries] = useState<NasEntry[]>([]);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");

  async function loadDir(path: string) {
    if (!path) return;
    setLoading(true);
    setSearchMode(false);
    try {
      const res = await api.nasFileList(path);
      setEntries(parseEntries(res, path));
    } catch (e) {
      onToast(`读取目录失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function initSpaces() {
    setLoading(true);
    try {
      const res = await api.nasFileSpace();
      const found = extractSpaces(res);
      setSpaces(found);
      const initial = settings?.nas_drop_dir || found[0] || "";
      if (initial) {
        setCurrentDir(initial);
        await loadDir(initial);
      }
    } catch (e) {
      onToast(`获取极空间存储目录失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void initSpaces();
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
  }, [currentDir]);

  async function enqueueUploads(paths: string[]) {
    if (!currentDir) {
      onToast("请先选择或等待加载目标 NAS 目录");
      return;
    }
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() || p;
      const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setJobs((prev) => [
        { id: jobId, name, localPath: p, destDir: currentDir, status: "uploading" },
        ...prev.slice(0, 19),
      ]);
      try {
        await api.nasUploadFile(p, currentDir, true);
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
    void loadDir(currentDir);
  }

  async function handlePickUpload() {
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
      if (currentDir) void loadDir(currentDir);
      return;
    }
    setLoading(true);
    setSearchMode(true);
    try {
      const res = await api.nasSearchFiles(q, currentDir || null);
      setEntries(parseEntries(res, currentDir));
    } catch (e) {
      onToast(`搜索失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function setAsDefaultDropDir() {
    if (!settings || !currentDir) return;
    const next = { ...settings, nas_drop_dir: currentDir };
    await api.saveSettings(next);
    onSettingsChanged(next);
    onToast(`已将「${currentDir}」设为默认投递目录`);
  }

  async function handleMkdir() {
    const name = newDirName.trim();
    if (!name || !currentDir) return;
    setCreatingDir(false);
    setNewDirName("");
    try {
      await api.nasMkdir(currentDir, name);
      onToast(`已创建文件夹「${name}」`);
      void loadDir(currentDir);
    } catch (e) {
      onToast(`创建文件夹失败：${String(e)}`);
    }
  }

  const rootSpace = spaces.find((s) => currentDir.startsWith(s)) ?? spaces[0] ?? "/";
  const relSegments = currentDir.startsWith(rootSpace)
    ? currentDir.slice(rootSpace.length).split("/").filter(Boolean)
    : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">文件快传箱</h1>
          <p className="text-[11px] text-slate-400">
            拖入桌面文件即可上传到极空间，或按关键词搜索 NAS 文件一键下载
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg bg-slate-100/90 px-2.5 py-1 focus-within:bg-white focus-within:ring-1 focus-within:ring-blue-400">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
              placeholder="搜索 NAS 文件，回车搜索"
              className="w-44 bg-transparent text-xs outline-none placeholder:text-slate-400"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  if (currentDir) void loadDir(currentDir);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => currentDir && void loadDir(currentDir)}
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

      {/* Drop Zone + Target Directory Bar */}
      <div className="border-b border-slate-100 bg-slate-50/60 px-5 py-3 space-y-2.5">
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
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-blue-600">
              {currentDir || "正在获取个人空间…"}
            </code>
          </div>
        </div>

        {/* Space selector + Breadcrumb + Mkdir + Set Default */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {spaces.length > 1 && (
            <select
              value={rootSpace}
              onChange={(e) => {
                setCurrentDir(e.target.value);
                void loadDir(e.target.value);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
            >
              {spaces.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}

          <div className="flex flex-wrap items-center gap-1 text-slate-600">
            <button
              type="button"
              onClick={() => {
                setCurrentDir(rootSpace);
                void loadDir(rootSpace);
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-slate-200/70"
            >
              <Home className="h-3.5 w-3.5 text-slate-400" />
              <span>{rootSpace}</span>
            </button>
            {relSegments.map((seg, i) => {
              const target = `${rootSpace.replace(/\/$/, "")}/${relSegments.slice(0, i + 1).join("/")}`;
              return (
                <span key={target} className="flex items-center gap-1">
                  <span className="text-slate-300">/</span>
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentDir(target);
                      void loadDir(target);
                    }}
                    className="rounded px-1.5 py-0.5 hover:bg-slate-200/70"
                  >
                    {seg}
                  </button>
                </span>
              );
            })}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {creatingDir ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={newDirName}
                  onChange={(e) => setNewDirName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleMkdir();
                    if (e.key === "Escape") setCreatingDir(false);
                  }}
                  placeholder="新建文件夹名"
                  className="w-28 rounded border border-blue-400 bg-white px-2 py-0.5 text-xs outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleMkdir()}
                  className="rounded bg-blue-600 px-2 py-0.5 text-white"
                >
                  确定
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreatingDir(true)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-600 hover:bg-slate-100"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                新建文件夹
              </button>
            )}

            {currentDir && currentDir !== settings?.nas_drop_dir && (
              <button
                type="button"
                onClick={() => void setAsDefaultDropDir()}
                className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-blue-600 hover:bg-blue-100"
              >
                设为默认投递目录
              </button>
            )}
          </div>
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
            <span>搜索「{query}」的结果（共 {entries.length} 项）</span>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                if (currentDir) void loadDir(currentDir);
              }}
              className="hover:underline"
            >
              返回目录浏览
            </button>
          </div>
        )}
        {entries.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">
            {loading ? "正在加载…" : searchMode ? "未找到匹配的文件" : "当前目录为空"}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <div
                key={entry.path}
                onDoubleClick={() => {
                  if (entry.isDir) {
                    setCurrentDir(entry.path);
                    void loadDir(entry.path);
                  }
                }}
                className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm hover:bg-slate-50"
              >
                {entry.isDir ? (
                  <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <FileIcon className="h-4 w-4 shrink-0 text-slate-400" />
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (entry.isDir) {
                      setCurrentDir(entry.path);
                      void loadDir(entry.path);
                    }
                  }}
                  className={`min-w-0 flex-1 truncate text-left ${
                    entry.isDir ? "font-medium text-slate-800 hover:text-blue-600" : "text-slate-700"
                  }`}
                >
                  {entry.name}
                  {searchMode && (
                    <span className="ml-2 text-[11px] font-normal text-slate-400">{entry.path}</span>
                  )}
                </button>
                <span className="w-20 text-right text-xs tabular-nums text-slate-400">
                  {entry.isDir ? "文件夹" : formatBytes(entry.size)}
                </span>
                <span className="hidden w-36 text-right text-[11px] text-slate-400 md:inline">
                  {entry.mtime}
                </span>
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
