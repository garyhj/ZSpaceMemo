import { Box, Check, Copy, Layers, Play, RefreshCw, RotateCw, Search, Square, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { confirmAction } from "../../components/ConfirmDialog";
import { ModalDialog } from "../../components/Modal";
import { formatBytes } from "../../utils/format";

interface Props {
  onToast: (msg: string) => void;
}

interface ContainerItem {
  id: string;
  name: string;
  image: string;
  state: string;
  statusText: string;
  running: boolean;
  cpu?: string;
  mem?: string;
}

function parseContainers(data: Record<string, unknown>): ContainerItem[] {
  const arr =
    (Array.isArray(data) ? data : data.list ?? data.containers ?? data.data ?? data.items) as
      | Record<string, unknown>[]
      | undefined;
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => {
    const id = String(r.id ?? r.container_id ?? r.Id ?? "");
    const rawName = r.name ?? r.Names ?? r.container_name ?? id.slice(0, 12);
    const name = Array.isArray(rawName)
      ? String(rawName[0] ?? "").replace(/^\//, "")
      : String(rawName).replace(/^\//, "");
    const image = String(r.image ?? r.Image ?? "-");
    const state = String(r.state ?? r.State ?? r.status ?? "").toLowerCase();
    const statusText = String(r.status_text ?? r.Status ?? r.status ?? state);
    const running = state === "running" || statusText.toLowerCase().startsWith("up");
    return { id, name, image, state, statusText, running };
  });
}

function parseStatsMap(data: Record<string, unknown>): Record<string, { cpu?: string; mem?: string }> {
  const arr =
    (Array.isArray(data) ? data : data.list ?? data.stats ?? data.data) as
      | Record<string, unknown>[]
      | undefined;
  const map: Record<string, { cpu?: string; mem?: string }> = {};
  if (!Array.isArray(arr)) return map;
  for (const r of arr) {
    const id = String(r.id ?? r.container_id ?? r.name ?? "");
    if (!id) continue;
    map[id] = {
      cpu: r.cpu_percent !== undefined ? `${r.cpu_percent}%` : r.cpu ? String(r.cpu) : undefined,
      mem: r.mem_usage ? String(r.mem_usage) : r.memory ? String(r.memory) : undefined,
    };
  }
  return map;
}

interface ImageItem {
  id: string;
  repoTag: string;
  size: number | null;
  created: string;
}

interface ComposeItem {
  name: string;
  status: string;
  services: string;
  path: string;
}

function parseImages(data: Record<string, unknown>): ImageItem[] {
  const arr =
    (Array.isArray(data) ? data : data.list ?? data.images ?? data.data ?? data.items) as
      | Record<string, unknown>[]
      | undefined;
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => {
    const id = String(r.id ?? r.Id ?? r.image_id ?? "").replace(/^sha256:/, "").slice(0, 12);
    const tags = Array.isArray(r.RepoTags)
      ? String(r.RepoTags[0] ?? "")
      : Array.isArray(r.tags)
      ? String(r.tags[0] ?? "")
      : "";
    const repoTag = String(r.name ?? r.repo_tag ?? r.repository ?? (tags || "<none>"));
    const rawSize = Number(r.size ?? r.Size ?? r.virtual_size ?? NaN);
    const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null;
    const created = String(r.created ?? r.Created ?? r.created_at ?? "");
    return { id, repoTag, size, created };
  });
}

function parseCompose(data: Record<string, unknown>): ComposeItem[] {
  const arr =
    (Array.isArray(data)
      ? data
      : data.list ?? data.projects ?? data.stacks ?? data.compose ?? data.data ?? data.items) as
      | Record<string, unknown>[]
      | undefined;
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => ({
    name: String(r.name ?? r.project_name ?? r.Name ?? "未命名项目"),
    status: String(r.status ?? r.Status ?? r.state ?? "未知"),
    services: String(r.services ?? r.Services ?? r.container_count ?? ""),
    path: String(r.path ?? r.config_files ?? r.ConfigFiles ?? r.dir ?? ""),
  }));
}

export function DockerBoardView({ onToast }: Props) {
  const [tab, setTab] = useState<"containers" | "images" | "compose">("containers");
  const [containers, setContainers] = useState<ContainerItem[]>([]);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [composes, setComposes] = useState<ComposeItem[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "running" | "stopped">("all");
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [logsTarget, setLogsTarget] = useState<{ name: string; text: string } | null>(null);
  const [copiedLogs, setCopiedLogs] = useState(false);

  async function copyLogs() {
    if (!logsTarget) return;
    try {
      await navigator.clipboard.writeText(logsTarget.text);
      setCopiedLogs(true);
      onToast("已复制容器日志");
      window.setTimeout(() => setCopiedLogs(false), 1600);
    } catch (e) {
      onToast(`复制失败：${String(e)}`);
    }
  }

  async function refresh(targetTab = tab) {
    setLoading(true);
    try {
      if (targetTab === "containers") {
        const [listRes, statsRes] = await Promise.allSettled([
          api.nasDockerList(),
          api.nasDockerStats(),
        ]);
        if (listRes.status === "fulfilled") {
          const list = parseContainers(listRes.value);
          const stats = statsRes.status === "fulfilled" ? parseStatsMap(statsRes.value) : {};
          setContainers(
            list.map((c) => ({
              ...c,
              cpu: stats[c.id]?.cpu ?? stats[c.name]?.cpu,
              mem: stats[c.id]?.mem ?? stats[c.name]?.mem,
            }))
          );
        } else {
          onToast(`获取容器列表失败：${String(listRes.reason)}`);
        }
      } else if (targetTab === "images") {
        const res = await api.nasDockerImagesList();
        setImages(parseImages(res));
      } else {
        const res = await api.nasDockerComposeList();
        setComposes(parseCompose(res));
      }
    } catch (e) {
      onToast(`加载失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh(tab);
  }, [tab]);

  async function runAction(c: ContainerItem, action: "start" | "stop" | "restart") {
    const zh = action === "start" ? "启动" : action === "stop" ? "停止" : "重启";
    if (
      action === "stop" &&
      !(await confirmAction({
        title: "停止容器",
        message: `确定停止容器「${c.name}」吗？`,
        confirmText: "停止",
        danger: true,
      }))
    ) {
      return;
    }
    setActingId(c.id);
    try {
      await api.nasDockerAction(action, c.id);
      onToast(`已${zh}容器「${c.name}」`);
      await refresh();
    } catch (e) {
      onToast(`${zh}失败：${String(e)}`);
    } finally {
      setActingId(null);
    }
  }

  async function openLogs(c: ContainerItem) {
    setLogsTarget({ name: c.name, text: "正在加载最近 100 条日志…" });
    try {
      const res = await api.nasDockerLogs(c.id);
      const raw = res.logs ?? res.data ?? res.content ?? res;
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
          ? raw.join("\n")
          : JSON.stringify(raw, null, 2);
      setLogsTarget({ name: c.name, text: text || "（暂无日志）" });
    } catch (e) {
      setLogsTarget({ name: c.name, text: `获取日志失败：${String(e)}` });
    }
  }

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return containers
      .filter((c) =>
        filter === "running" ? c.running : filter === "stopped" ? !c.running : true
      )
      .filter((c) =>
        !kw ? true : c.name.toLowerCase().includes(kw) || c.image.toLowerCase().includes(kw)
      );
  }, [containers, query, filter]);

  const runningCount = containers.filter((c) => c.running).length;

  const filteredImages = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return !kw
      ? images
      : images.filter((i) => i.repoTag.toLowerCase().includes(kw) || i.id.toLowerCase().includes(kw));
  }, [images, query]);

  const filteredComposes = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return !kw
      ? composes
      : composes.filter((p) => p.name.toLowerCase().includes(kw) || p.path.toLowerCase().includes(kw));
  }, [composes, query]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Docker 看板</h1>
          <p className="text-[11px] text-slate-400">
            {tab === "containers"
              ? `共 ${containers.length} 个容器 · ${runningCount} 个运行中`
              : tab === "images"
              ? `共 ${images.length} 个本地镜像`
              : `共 ${composes.length} 个 Compose 项目`}
          </p>
        </div>

        <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
          {(
            [
              ["containers", "容器"],
              ["images", "镜像"],
              ["compose", "Compose"],
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {tab === "containers" && (
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
              {(
                [
                  ["all", "全部"],
                  ["running", "运行中"],
                  ["stopped", "已停止"],
                ] as const
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(k)}
                  className={`rounded-md px-2.5 py-1 ${
                    filter === k ? "bg-white font-medium text-blue-600 shadow-2xs" : "text-slate-500"
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 rounded-lg bg-slate-100/90 px-2.5 py-1 focus-within:bg-white focus-within:ring-1 focus-within:ring-blue-400">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === "compose" ? "搜索 Compose 项目" : "搜索容器或镜像"}
              className="w-36 bg-transparent text-xs outline-none placeholder:text-slate-400"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} className="text-slate-400 hover:text-slate-600">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => void refresh(tab)}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-slate-50/50 p-5">
        {tab === "images" ? (
          filteredImages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
              <Layers className="h-10 w-10 text-slate-200" strokeWidth={1.5} />
              <span className="text-sm">{loading ? "正在加载本地镜像…" : "暂无匹配的 Docker 镜像"}</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
              {filteredImages.map((img, i) => (
                <div
                  key={`${img.id}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-slate-800">{img.repoTag}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                      ID: {img.id || "-"}
                      {img.created ? ` · ${img.created}` : ""}
                    </div>
                  </div>
                  {img.size !== null && (
                    <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">
                      {formatBytes(img.size)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )
        ) : tab === "compose" ? (
          filteredComposes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
              <Layers className="h-10 w-10 text-slate-200" strokeWidth={1.5} />
              <span className="text-sm">{loading ? "正在加载 Compose 项目…" : "暂无 Compose 项目"}</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {filteredComposes.map((p, i) => (
                <div
                  key={`${p.name}-${i}`}
                  className="rounded-xl border border-slate-200 bg-white p-4 text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-slate-900">{p.name}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                      {p.status}
                    </span>
                  </div>
                  {p.services && <div className="text-slate-500">服务：{p.services}</div>}
                  {p.path && <div className="truncate font-mono text-[11px] text-slate-400">{p.path}</div>}
                </div>
              ))}
            </div>
          )
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
            <Box className="h-10 w-10 text-slate-200" strokeWidth={1.5} />
            <span className="text-sm">{loading ? "正在加载容器…" : "没有匹配的 Docker 容器"}</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {filtered.map((c) => {
              const busy = actingId === c.id;
              return (
                <div
                  key={c.id}
                  className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                        c.running ? "bg-emerald-500" : "bg-slate-300"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-900">
                          {c.name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            c.running
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {c.running ? "运行中" : "已停止"}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                        {c.image}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-500">
                        <span>{c.statusText}</span>
                        {c.cpu && <span>CPU: {c.cpu}</span>}
                        {c.mem && <span>内存: {c.mem}</span>}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-1.5 border-t border-slate-100 pt-2.5 text-xs">
                    {!c.running ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(c, "start")}
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        <Play className="h-3 w-3" />
                        启动
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void runAction(c, "restart")}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          <RotateCw className="h-3 w-3" />
                          重启
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void runAction(c, "stop")}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1 text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          <Square className="h-3 w-3" />
                          停止
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => void openLogs(c)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-slate-600 hover:bg-slate-50"
                    >
                      <Terminal className="h-3 w-3" />
                      日志
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {logsTarget && (
        <ModalDialog
          open
          ariaLabel="容器日志"
          onClose={() => setLogsTarget(null)}
          dialogClassName="w-[min(48rem,calc(100vw-3rem))]"
          className="flex max-h-[80vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 text-slate-100 shadow-2xl"
        >
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
              <span className="text-xs font-semibold">容器日志 · {logsTarget.name}</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void copyLogs()}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                >
                  {copiedLogs ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedLogs ? "已复制" : "复制日志"}
                </button>
                <button
                  type="button"
                  onClick={() => setLogsTarget(null)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <pre className="select-text flex-1 overscroll-contain overflow-auto p-4 font-mono text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap">
              {logsTarget.text}
            </pre>
        </ModalDialog>
      )}
    </div>
  );
}
