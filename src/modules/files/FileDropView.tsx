import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
  Upload,
  Wifi,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import type { AppSettings, UploadBatchProgress } from "../../types";

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

interface TransferJob {
  id: string;
  direction: "upload" | "download";
  name: string;
  localPath: string;
  remotePath: string; // upload: destDir; download: nasPath
  status: "queued" | "running" | "done" | "error";
  error?: string;
}

const PAGE_SIZE = 100;

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

function parseRawEntries(data: Record<string, unknown>, basePath: string): {
  entries: NasEntry[];
  rawCount: number;
} {
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
  entries.sort(
    (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, "zh-CN")
  );
  return { entries, rawCount: arr.length };
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

function joinLocalPath(dir: string, filename: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const cleanDir = dir.replace(/[\\/]+$/, "");
  return `${cleanDir}${sep}${filename}`;
}

export function FileDropView({ settings, onSettingsChanged, onToast }: Props) {
  const [lockedDir, setLockedDir] = useState<string>("");
  const lockedDirRef = useRef<string>("");
  lockedDirRef.current = lockedDir;

  const [entries, setEntries] = useState<NasEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [batchStatus, setBatchStatus] = useState<string>("");

  function upsertJob(job: TransferJob) {
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === job.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = job;
        return copy;
      }
      return [job, ...prev].slice(0, 40);
    });
  }

  async function loadDir(path: string, append = false) {
    if (!path) return;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setSearchMode(false);
    }
    try {
      const start = append ? entries.length : 0;
      const res = await api.nasFileList(path, start, PAGE_SIZE);
      const { entries: parsed, rawCount } = parseRawEntries(res, path);
      setHasMore(rawCount >= PAGE_SIZE);
      if (append) {
        setEntries((prev) => {
          const map = new Map<string, NasEntry>();
          for (const e of prev) map.set(e.path, e);
          for (const e of parsed) map.set(e.path, e);
          return Array.from(map.values()).sort(
            (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, "zh-CN")
          );
        });
      } else {
        setEntries(parsed);
        setSelectedPaths(new Set());
      }
    } catch (e) {
      onToast(`读取「我的文件/downloads」失败：${String(e)}`);
    } finally {
      setLoading(false);
      setLoadingMore(false);
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
          const listRes = await api.nasFileList(saved, 0, PAGE_SIZE);
          const { entries: parsed, rawCount } = parseRawEntries(listRes, saved);
          setLockedDir(saved);
          setEntries(parsed);
          setHasMore(rawCount >= PAGE_SIZE);
          setSelectedPaths(new Set());
          return;
        } catch {
          // Fall through to full discovery across personal spaces.
        }
      }

      // 2. Scan personal spaces to find an existing `downloads` folder (exact lowercase preferred).
      const spaceLists = await Promise.allSettled(spaces.map((s) => api.nasFileList(s, 0, PAGE_SIZE)));
      let targetDir = "";
      let ciFallback = "";
      spaces.forEach((space, idx) => {
        const result = spaceLists[idx];
        if (result.status !== "fulfilled") return;
        const { entries: items } = parseRawEntries(result.value, space);
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
      const listRes = await api.nasFileList(targetDir, 0, PAGE_SIZE);
      const { entries: parsed, rawCount } = parseRawEntries(listRes, targetDir);
      setEntries(parsed);
      setHasMore(rawCount >= PAGE_SIZE);
      setSelectedPaths(new Set());
    } catch (e) {
      onToast(`定位「我的文件/downloads」失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void initDownloadsDir();
  }, []);

  // Listen to Rust batch transfer progress events
  useEffect(() => {
    const un = listen<UploadBatchProgress>("files:transfer-progress", (ev) => {
      const p = ev.payload;
      setBatchStatus(
        p.status === "uploading"
          ? `正在上传 (${p.current}/${p.total})：${p.name}`
          : ""
      );
      upsertJob({
        id: p.job_id,
        direction: "upload",
        name: p.name,
        localPath: p.local_path,
        remotePath: p.dest_dir,
        status:
          p.status === "uploading" ? "running" : p.status === "done" ? "done" : "error",
        error: p.error ?? undefined,
      });
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Listen to native OS drag-drop (supports both files and folders)
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "enter" || ev.payload.type === "over") {
        setDragOver(true);
      } else if (ev.payload.type === "leave") {
        setDragOver(false);
      } else if (ev.payload.type === "drop") {
        setDragOver(false);
        if (ev.payload.paths.length > 0) {
          void enqueueUploadPaths(ev.payload.paths);
        }
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  async function enqueueUploadPaths(paths: string[], targetDirOverride?: string) {
    const targetDir = targetDirOverride ?? lockedDirRef.current;
    if (!targetDir) {
      onToast("正在定位「我的文件/downloads」目录，请稍后再试");
      return;
    }
    const batchId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      const summary = await api.nasUploadPaths(paths, targetDir, true, batchId);
      setBatchStatus("");
      if (summary.total_files === 0 && summary.created_dirs > 0) {
        onToast(`已创建 ${summary.created_dirs} 个目录（文件夹内暂无可上传文件）`);
      } else if (summary.failed > 0) {
        onToast(`上传完成：成功 ${summary.succeeded} 个，失败 ${summary.failed} 个`);
      } else if (summary.total_files > 0) {
        const dirHint = summary.created_dirs > 0 ? `（含 ${summary.created_dirs} 个目录）` : "";
        onToast(`已上传 ${summary.succeeded} 个文件到「我的文件/downloads」${dirHint}`);
      }
      if (lockedDirRef.current) {
        void loadDir(lockedDirRef.current);
      }
    } catch (e) {
      setBatchStatus("");
      onToast(`上传失败：${String(e)}`);
    }
  }

  async function handlePickUpload(directory: boolean) {
    if (!lockedDir) {
      onToast("正在定位「我的文件/downloads」目录，请稍候");
      return;
    }
    const picked = await open({ multiple: true, directory });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    if (list.length > 0) {
      await enqueueUploadPaths(list);
    }
  }

  async function runDownloadJob(job: TransferJob) {
    upsertJob({ ...job, status: "running", error: undefined });
    try {
      await api.nasDownloadFile(job.remotePath, job.localPath);
      upsertJob({ ...job, status: "done", error: undefined });
      return true;
    } catch (e) {
      upsertJob({ ...job, status: "error", error: String(e) });
      return false;
    }
  }

  async function handleDownload(entry: NasEntry) {
    const localDest = await save({ defaultPath: entry.name });
    if (!localDest) return;
    const job: TransferJob = {
      id: `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      direction: "download",
      name: entry.name,
      localPath: localDest,
      remotePath: entry.path,
      status: "running",
    };
    const ok = await runDownloadJob(job);
    onToast(ok ? `已下载到 ${localDest}` : `「${entry.name}」下载失败，可在传输队列点击重试`);
  }

  const downloadableFiles = useMemo(() => entries.filter((e) => !e.isDir), [entries]);
  const selectedFiles = useMemo(
    () => downloadableFiles.filter((e) => selectedPaths.has(e.path)),
    [downloadableFiles, selectedPaths]
  );

  async function handleBatchDownload() {
    if (selectedFiles.length === 0) return;
    const targetDir = await open({ multiple: false, directory: true });
    if (!targetDir || Array.isArray(targetDir)) return;

    const batchJobs: TransferJob[] = selectedFiles.map((entry, idx) => ({
      id: `dl_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`,
      direction: "download",
      name: entry.name,
      localPath: joinLocalPath(targetDir, entry.name),
      remotePath: entry.path,
      status: "queued",
    }));

    for (const j of [...batchJobs].reverse()) {
      upsertJob(j);
    }

    let okCount = 0;
    let errCount = 0;
    for (let i = 0; i < batchJobs.length; i++) {
      setBatchStatus(`正在下载 (${i + 1}/${batchJobs.length})：${batchJobs[i].name}`);
      const ok = await runDownloadJob(batchJobs[i]);
      if (ok) okCount++;
      else errCount++;
    }
    setBatchStatus("");
    setSelectedPaths(new Set());
    onToast(
      errCount > 0
        ? `批量下载完成：成功 ${okCount} 个，失败 ${errCount} 个`
        : `已批量下载 ${okCount} 个文件到 ${targetDir}`
    );
  }

  async function handleRetryJob(job: TransferJob) {
    if (job.direction === "download") {
      const ok = await runDownloadJob(job);
      if (ok) onToast(`重试下载「${job.name}」成功`);
    } else {
      upsertJob({ ...job, status: "running", error: undefined });
      await enqueueUploadPaths([job.localPath], job.remotePath);
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
    setHasMore(false);
    try {
      const res = await api.nasSearchFiles(q, lockedDir);
      const { entries: parsed } = parseRawEntries(res, lockedDir);
      setEntries(parsed);
      setSelectedPaths(new Set());
    } catch (e) {
      onToast(`搜索失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  const allFilesSelected =
    downloadableFiles.length > 0 &&
    downloadableFiles.every((f) => selectedPaths.has(f.path));

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">文件快传箱</h1>
            {settings?.connection_mode === "lan" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                <Wifi className="h-2.5 w-2.5" />
                LAN 直连
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-400">
            专用中转目录，固定收发于极空间「个人空间 / 我的文件/downloads」（支持拖拽文件与文件夹）
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg bg-slate-100/90 px-2.5 py-1 focus-within:bg-white focus-within:ring-1 focus-within:ring-blue-400">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
              placeholder="搜索 downloads 内文件，回车"
              className="w-44 bg-transparent text-xs outline-none placeholder:text-slate-400"
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
            onClick={() => void handlePickUpload(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <FolderPlus className="h-3.5 w-3.5 text-blue-600" />
            上传文件夹
          </button>

          <button
            type="button"
            onClick={() => void handlePickUpload(false)}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Upload className="h-3.5 w-3.5" />
            上传文件
          </button>
        </div>
      </div>

      {/* Drop Zone + Locked Directory Indicator */}
      <div className="border-b border-slate-100 bg-slate-50/60 px-5 py-3 space-y-2">
        <div
          onClick={() => void handlePickUpload(false)}
          className={`flex cursor-pointer items-center justify-center gap-3 rounded-xl border-2 border-dashed py-3.5 transition ${
            dragOver
              ? "border-blue-500 bg-blue-50 text-blue-700"
              : "border-slate-300/80 bg-white text-slate-500 hover:border-blue-400 hover:bg-blue-50/30"
          }`}
        >
          <FolderUp className="h-5 w-5 text-blue-600" />
          <div className="text-xs">
            <span className="font-medium text-slate-700">把电脑上的文件或文件夹拖到这里</span>
            <span className="text-slate-400">（或点击选择文件），将直接同步至：</span>
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
          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            {batchStatus && <span className="font-medium text-blue-600">{batchStatus}</span>}
            <span>
              {entries.some((e) => e.isDir)
                ? `${entries.filter((e) => e.isDir).length} 个目录 · ${
                    entries.filter((e) => !e.isDir).length
                  } 个文件`
                : `共 ${entries.length} 个文件`}
            </span>
          </div>
        </div>
      </div>

      {/* Unified Upload + Download Queue */}
      {jobs.length > 0 && (
        <div className="border-b border-slate-100 bg-white px-5 py-2 space-y-1">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
            <span>传输队列（{jobs.length}）</span>
            <button type="button" onClick={() => setJobs([])} className="hover:text-slate-600">
              清空记录
            </button>
          </div>
          <div className="max-h-28 space-y-1 overflow-y-auto">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center gap-2 text-xs">
                {j.direction === "upload" ? (
                  <ArrowUpCircle className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                ) : (
                  <ArrowDownCircle className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                )}
                {j.status === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" />
                ) : j.status === "queued" ? (
                  <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                ) : j.status === "done" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                )}
                <span className="truncate font-medium text-slate-700">{j.name}</span>
                <span className="truncate text-[11px] text-slate-400">
                  {j.direction === "upload" ? "上传至 downloads" : `保存到 ${j.localPath}`}
                </span>
                {j.error && (
                  <span title={j.error} className="ml-auto max-w-[200px] truncate text-[11px] text-red-500">
                    {j.error}
                  </span>
                )}
                {j.status === "error" && (
                  <button
                    type="button"
                    onClick={() => void handleRetryJob(j)}
                    className="ml-1 inline-flex shrink-0 items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-100"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                    重试
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Batch Select Toolbar (only shown when downloadable files exist) */}
      {downloadableFiles.length > 0 && (
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/40 px-5 py-1.5 text-xs">
          <label className="inline-flex cursor-pointer items-center gap-2 text-slate-600">
            <input
              type="checkbox"
              checked={allFilesSelected}
              onChange={(e) => {
                if (e.target.checked) {
                  setSelectedPaths(new Set(downloadableFiles.map((f) => f.path)));
                } else {
                  setSelectedPaths(new Set());
                }
              }}
              className="h-3.5 w-3.5 accent-blue-600"
            />
            <span>全选当前列表文件（{downloadableFiles.length}）</span>
          </label>
          {selectedFiles.length > 0 && (
            <button
              type="button"
              onClick={() => void handleBatchDownload()}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
            >
              <Download className="h-3 w-3" />
              批量下载选中（{selectedFiles.length}）
            </button>
          )}
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
            {entries.map((entry) => {
              const checked = selectedPaths.has(entry.path);
              return (
                <div
                  key={entry.path}
                  className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm ${
                    checked ? "bg-blue-50/50" : "hover:bg-slate-50"
                  }`}
                >
                  <div className="flex w-4 shrink-0 justify-center">
                    {!entry.isDir && (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSelectedPaths((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(entry.path);
                            else next.delete(entry.path);
                            return next;
                          });
                        }}
                        className="h-3.5 w-3.5 accent-blue-600"
                      />
                    )}
                  </div>
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
              );
            })}
            {hasMore && !searchMode && (
              <div className="pt-3 pb-2 text-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => lockedDir && void loadDir(lockedDir, true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
                  {loadingMore ? "加载中…" : "加载更多文件"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
