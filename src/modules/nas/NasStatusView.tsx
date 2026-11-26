import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Bell,
  Check,
  CheckCheck,
  Code2,
  Copy,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Thermometer,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { AppSettings, SystemOverview } from "../../types";

interface Props {
  settings: AppSettings | null;
  onSettingsChanged: (cfg: AppSettings) => void;
  onToast: (msg: string) => void;
}

interface EventRow {
  id: string;
  title: string;
  body: string;
  level: string;
  time: string;
  unread: boolean;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArr(v: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => Boolean(asObj(x)));
  const o = asObj(v);
  if (!o) return [];
  for (const k of keys) {
    if (Array.isArray(o[k])) {
      return (o[k] as unknown[]).filter((x): x is Record<string, unknown> => Boolean(asObj(x)));
    }
  }
  return [];
}

const SKIP_CHILD_KEYS = new Set([
  "disks",
  "disk_list",
  "pool_list",
  "pools",
  "mounts",
  "cache_list",
  "free_list",
  "ext_mnt_list",
  "nic_list",
  "nets",
  "processes",
]);

/** Collect nested candidate objects from ZSpace CLI/ZOS JSON envelopes (e.g. detail.list[0], polling). */
function collectObjs(root: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  const priorityKeys = [
    "detail",
    "polling",
    "polling2",
    "sysinfo",
    "system",
    "info",
    "data",
    "fields",
    "status",
    "runtime",
    "summary",
    "temperatures",
    "hardware",
    "list",
    "items",
    "rows",
    "result",
  ];
  while (queue.length > 0 && out.length < 64) {
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      for (const item of cur.slice(0, 4)) {
        if (asObj(item) && !seen.has(item)) queue.push(item);
      }
      continue;
    }
    const o = asObj(cur);
    if (!o || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
    for (const k of priorityKeys) {
      if (o[k] !== undefined && !SKIP_CHILD_KEYS.has(k)) {
        queue.push(o[k]);
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (SKIP_CHILD_KEYS.has(k) || priorityKeys.includes(k)) continue;
      if (asObj(v) || Array.isArray(v)) {
        queue.push(v);
      }
    }
  }
  return out;
}

function pickFrom(objs: (Record<string, unknown> | null)[], keys: string[]): string {
  for (const obj of objs) {
    if (!obj) continue;
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return "-";
}

function parseNumeric(val: unknown): number | null {
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val === "string") {
    const cleaned = val.trim().replace(/[,%°℃CF\s]+$/gi, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickNumFrom(objs: (Record<string, unknown> | null)[], keys: string[]): number | null {
  for (const obj of objs) {
    if (!obj) continue;
    for (const k of keys) {
      const n = parseNumeric(obj[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

function pick(obj: Record<string, unknown> | null, keys: string[]): string {
  return pickFrom([obj], keys);
}

function pickNum(obj: Record<string, unknown> | null, keys: string[]): number | null {
  return pickNumFrom([obj], keys);
}

function fmtSize(val: number | null): string {
  if (val === null || val <= 0) return "-";
  let bytes = val;
  if (bytes < 1e6) bytes = val * 1024 * 1024;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function fmtMemSize(val: number | null): string {
  if (val === null || val <= 0) return "-";
  let bytes = val;
  if (val <= 512) {
    bytes = val * 1024 * 1024 * 1024; // GiB
  } else if (val < 524_288) {
    bytes = val * 1024 * 1024; // MiB
  } else if (val < 536_870_912) {
    bytes = val * 1024; // KiB
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

export function NasStatusView({ settings, onSettingsChanged, onToast }: Props) {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventFilter, setEventFilter] = useState<"notify" | "log" | "">("notify");
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);

  async function copyRawJson() {
    if (!overview) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(overview, null, 2));
      setCopiedRaw(true);
      onToast("已复制原始 JSON");
      window.setTimeout(() => setCopiedRaw(false), 1600);
    } catch (e) {
      onToast(`复制失败：${String(e)}`);
    }
  }

  async function refreshAll(evType = eventFilter) {
    setLoading(true);
    try {
      const [ovRes, evRes] = await Promise.allSettled([
        api.nasSystemOverview(),
        api.nasListEvents(evType, 30),
      ]);
      if (ovRes.status === "fulfilled") {
        setOverview(ovRes.value);
      } else {
        onToast(`获取 NAS 状态失败：${String(ovRes.reason)}`);
      }
      if (evRes.status === "fulfilled") {
        const rows = asArr(evRes.value, ["list", "events", "items", "data"]).map((r) => ({
          id: String(r.id ?? r.event_id ?? Math.random()),
          title: pick(r, ["title", "event_name", "group", "action"]),
          body: pick(r, ["content", "message", "msg", "desc", "detail"]),
          level: pick(r, ["level", "severity"]),
          time: pick(r, ["created_at", "time", "ctime", "create_time"]),
          unread: Number(r.is_new ?? r.unread ?? (r.is_read === false ? 1 : 0)) === 1,
        }));
        setEvents(rows);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll(eventFilter);
  }, [eventFilter]);

  useEffect(() => {
    const un = listen("nas:events-updated", () => void refreshAll(eventFilter));
    return () => {
      void un.then((f) => f());
    };
  }, [eventFilter]);

  async function toggleBridge(checked: boolean) {
    if (!settings) return;
    const next = { ...settings, bridge_nas_events: checked };
    await api.saveSettings(next);
    onSettingsChanged(next);
    onToast(checked ? "已开启：极空间新告警将同步弹出桌面系统通知" : "已关闭 NAS 告警弹窗转发");
  }

  async function markOneRead(id: string) {
    try {
      await api.nasMarkEventsRead(id);
      setEvents((cur) => cur.map((e) => (e.id === id ? { ...e, unread: false } : e)));
    } catch (e) {
      onToast(`操作失败：${String(e)}`);
    }
  }

  async function markAllRead() {
    try {
      await api.nasMarkAllEventsRead();
      setEvents((cur) => cur.map((e) => ({ ...e, unread: false })));
      onToast("已全部标为已读");
    } catch (e) {
      onToast(`操作失败：${String(e)}`);
    }
  }

  const sysObjs = collectObjs(overview?.system);
  const basicObjs = [
    ...sysObjs.flatMap((o) => [asObj(o.basic), asObj(o.system), asObj(o.os), asObj(o.device)]),
    ...sysObjs,
  ].filter((x): x is Record<string, unknown> => Boolean(x));

  const cpuSelfObjs = sysObjs
    .flatMap((o) => [asObj(o.cpu), asObj(o.cpu_info)])
    .filter((x): x is Record<string, unknown> => Boolean(x));
  const cpuObjs = [...cpuSelfObjs, ...sysObjs];

  const memSelfObjs = sysObjs
    .flatMap((o) => [asObj(o.memory), asObj(o.mem), asObj(o.mem_info), asObj(o.ram)])
    .filter((x): x is Record<string, unknown> => Boolean(x));
  const memObjs = [...memSelfObjs, ...sysObjs];

  const fanObjs = [
    ...sysObjs.flatMap((o) => [
      asObj(o.fan),
      asObj(o.sys_fan),
      asObj(o.hard_fan),
      asObj(o.fan_info),
    ]),
    ...sysObjs.flatMap((o) => asArr(o, ["fans", "fan_list"])),
    ...sysObjs.flatMap((o) => [asObj(o.cpu_fan)]),
    ...sysObjs,
  ].filter((x): x is Record<string, unknown> => Boolean(x));

  const deviceName = pickFrom(basicObjs, ["device_name", "name", "model", "hostname", "product"]);
  const sysVersion = pickFrom(basicObjs, [
    "version",
    "os_version",
    "zos_version",
    "sys_version",
    "soft_version",
    "firmware",
    "rom_version",
    "ver",
  ]);
  const nasId = pickFrom(basicObjs, ["nasid", "nas_id", "sn", "serial"]);

  // CPU metrics: check dedicated CPU object first (ZOS detail uses `cpu.used` in 0..1), then polling scalars
  const directCpuNum = sysObjs
    .map((o) => parseNumeric(o.cpu))
    .find((n): n is number => n !== null);
  const cpuExplicitPct = pickNumFrom(cpuObjs, [
    "usage",
    "percent",
    "used_percent",
    "usage_percent",
    "cpu_usage",
    "cpuUsage",
    "cpu_percent",
    "cpuPercent",
    "cpu_use",
    "cpuUse",
    "utilization",
    "busy",
  ]);
  const cpuRatioOrPct =
    cpuExplicitPct === null
      ? pickNumFrom(cpuSelfObjs, ["used", "use", "rate", "ratio"]) ??
        pickNumFrom(sysObjs, ["cpu_used", "cpu_rate", "cpu_ratio"])
      : null;
  const cpuPct =
    cpuExplicitPct ??
    (cpuRatioOrPct !== null
      ? cpuRatioOrPct > 0 && cpuRatioOrPct < 1
        ? cpuRatioOrPct * 100
        : cpuRatioOrPct
      : directCpuNum ?? null);
  const cpuLoad = pickNumFrom(cpuObjs, ["load", "load1", "load_1", "load_avg", "loadavg"]);
  const cpuTemp = pickNumFrom(cpuObjs, ["temp", "temperature", "cpu_temp", "cpuTemp", "core_temp"]);
  const cpuModel = pickFrom(cpuObjs, ["model", "model_name", "cpu_model", "brand", "name"]);
  const cpuCores = pickNumFrom(cpuObjs, ["cores", "core_num", "cpu_cores", "threads"]);

  const cpuValue =
    cpuPct !== null
      ? `${cpuPct.toFixed(1)}%`
      : cpuLoad !== null
      ? `Load ${cpuLoad.toFixed(2)}`
      : cpuCores !== null
      ? `${cpuCores} 核`
      : cpuModel !== "-"
      ? cpuModel
      : "-";
  const cpuSub =
    [
      cpuTemp !== null ? `温度 ${cpuTemp}°C` : null,
      cpuPct !== null && cpuLoad !== null ? `负载 ${cpuLoad.toFixed(2)}` : null,
      cpuModel !== "-" ? cpuModel : cpuCores !== null ? `${cpuCores} 核心` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "处理器运行状态";

  // Memory metrics (supports bytes/MB/GB AND fractional 0..1 `mem.used` / `mem.rate`)
  const memTotal = pickNumFrom(memObjs, [
    "total",
    "total_bytes",
    "total_size",
    "mem_total",
    "physical_total",
    "size",
    "all",
    "capacity",
  ]);
  const memFree = pickNumFrom(memObjs, ["free", "available", "avail", "mem_free", "mem_avail"]);
  const memUsedRaw =
    pickNumFrom(memSelfObjs, [
      "used",
      "used_bytes",
      "usage_size",
      "mem_used",
      "active",
      "usage_mem",
    ]) ?? pickNumFrom(sysObjs, ["mem_used", "used_mem", "memory_used"]);
  const memRatioField = pickNumFrom(memSelfObjs, [
    "usage",
    "percent",
    "used_percent",
    "usage_percent",
    "rate",
    "ratio",
  ]);
  const memScalarPct = pickNumFrom(sysObjs, [
    "mem_usage",
    "memUsage",
    "mem_percent",
    "memPercent",
    "memory_usage",
    "mem_rate",
  ]);
  const memUsedIsRatio = memUsedRaw !== null && memUsedRaw > 0 && memUsedRaw < 1;
  const memUsed =
    memUsedIsRatio && memTotal !== null
      ? memTotal * memUsedRaw
      : memUsedRaw !== null && !memUsedIsRatio
      ? memUsedRaw
      : memTotal !== null && memFree !== null
      ? Math.max(0, memTotal - memFree)
      : null;
  const memPctRaw = memRatioField ?? memScalarPct ?? (memUsedIsRatio ? memUsedRaw : null);
  const memPct =
    memPctRaw !== null
      ? memPctRaw > 0 && memPctRaw < 1
        ? memPctRaw * 100
        : memPctRaw
      : memUsed !== null && memTotal && memTotal > 0
      ? (memUsed / memTotal) * 100
      : null;

  // Fan metrics (ignore negative sentinel RPM like `cpu_fan.speed: -1`)
  const fanRpm = (() => {
    const keys = ["rpm", "speed", "fan_speed", "fan1", "fan2", "cur_speed", "value"];
    for (const obj of fanObjs) {
      for (const k of keys) {
        const n = parseNumeric(obj[k]);
        if (n !== null && n >= 0) return n;
      }
    }
    return null;
  })();
  const fanMode = pickFrom(fanObjs, ["mode", "level", "fan_mode", "status_text", "mode_name"]);
  const fanValue =
    fanRpm !== null
      ? `${Math.round(fanRpm)} RPM`
      : cpuTemp !== null
      ? `${cpuTemp}°C`
      : fanMode !== "-"
      ? fanMode
      : "-";
  const fanSub =
    fanRpm !== null
      ? [
          fanMode !== "-" ? `模式 ${fanMode}` : null,
          cpuTemp !== null ? `核心温度 ${cpuTemp}°C` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "实时转速"
      : cpuTemp !== null
      ? `核心温度 · ${fanMode !== "-" ? fanMode : "未读取到风扇转速"}`
      : "风扇状态";

  // Storage pools & disks (supports `/zspool/info` `pool_list` + `total_size` / `usage_size`)
  const pools = asArr(overview?.storage, [
    "pools",
    "pool_list",
    "list",
    "storage_pools",
    "sys_pools",
    "data",
  ]);
  const rawDisks = asArr(overview?.disk, [
    "disks",
    "mounts",
    "disk_list",
    "list",
    "statics",
    "data",
  ]);
  const nestedPoolDisks = pools.flatMap((p) => asArr(p, ["disk_list", "disks"]));
  const disks = rawDisks.length > 0 ? rawDisks : nestedPoolDisks;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">NAS 状态与消息</h1>
          <p className="text-[11px] text-slate-400">
            设备：{deviceName}
            {sysVersion !== "-"
              ? ` · 系统：${sysVersion}`
              : nasId !== "-"
              ? ` · NAS ID：${nasId}`
              : ""}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
          >
            <Code2 className="h-3.5 w-3.5" />
            {showRaw ? "隐藏原始 JSON" : "原始数据"}
          </button>
          <button
            type="button"
            onClick={() => void refreshAll(eventFilter)}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新状态
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-slate-50/50 p-5 space-y-5">
        {/* Hardware Cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={<Cpu className="h-4 w-4 text-blue-600" />}
            label="CPU 负载"
            value={cpuValue}
            sub={cpuSub}
          />
          <StatCard
            icon={<MemoryStick className="h-4 w-4 text-emerald-600" />}
            label="内存占用"
            value={memPct !== null ? `${memPct.toFixed(1)}%` : "-"}
            sub={memTotal ? `${fmtMemSize(memUsed)} / ${fmtMemSize(memTotal)}` : "系统内存"}
          />
          <StatCard
            icon={<Thermometer className="h-4 w-4 text-amber-500" />}
            label="散热 / 风扇"
            value={fanValue}
            sub={fanSub}
          />
          <StatCard
            icon={<Activity className="h-4 w-4 text-violet-600" />}
            label="存储池 / 硬盘"
            value={`${pools.length || "-"} 池 · ${disks.length || "-"} 盘`}
            sub={overview?.errors.length ? `部分字段受限 (${overview.errors.length})` : "在线监测中"}
          />
        </div>

        {/* Storage Pools */}
        {pools.length > 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <HardDrive className="h-4 w-4 text-blue-600" />
              存储池容量
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {pools.map((p, idx) => {
                const name = pick(p, ["name", "pool_name", "id", "label"]);
                const total = pickNum(p, ["total", "total_bytes", "total_size", "size", "capacity"]);
                const free = pickNum(p, ["free", "free_size", "available"]);
                const usedRaw = pickNum(p, ["used", "used_bytes", "usage_size"]);
                const used =
                  usedRaw !== null
                    ? usedRaw
                    : total !== null && free !== null
                    ? Math.max(0, total - free)
                    : null;
                const pct =
                  used !== null && total && total > 0
                    ? Math.min(100, Math.round((used / total) * 100))
                    : pickNum(p, ["usage", "percent"]) ?? 0;
                return (
                  <div key={idx} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-800">{name}</span>
                      <span className="text-slate-500">
                        {pick(p, ["pool_type", "raid", "raid_type", "status", "health"])} · {pct}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : "bg-blue-600"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {total !== null && (
                      <div className="text-[11px] text-slate-400">
                        已用 {fmtSize(used)} / 总共 {fmtSize(total)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Raw JSON Inspector */}
        {showRaw && overview && (
          <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2 text-[11px] text-slate-300">
              <span>原始系统遥测 JSON</span>
              <button
                type="button"
                onClick={() => void copyRawJson()}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
              >
                {copiedRaw ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {copiedRaw ? "已复制" : "复制 JSON"}
              </button>
            </div>
            <pre className="select-text max-h-72 overflow-auto p-4 font-mono text-[11px] text-slate-100">
              {JSON.stringify(overview, null, 2)}
            </pre>
          </div>
        )}

        {/* NAS Events & Notification Bridge */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-blue-600" />
              <span className="text-sm font-semibold text-slate-800">极空间 NAS 消息与事件</span>
              <div className="ml-2 flex rounded-lg bg-slate-100 p-0.5 text-[11px]">
                {(
                  [
                    ["notify", "通知"],
                    ["log", "日志"],
                    ["", "全部"],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={lbl}
                    type="button"
                    onClick={() => setEventFilter(k)}
                    className={`rounded-md px-2 py-0.5 ${
                      eventFilter === k ? "bg-white font-medium text-blue-600 shadow-2xs" : "text-slate-500"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5 text-slate-600">
                <input
                  type="checkbox"
                  checked={settings?.bridge_nas_events !== false}
                  onChange={(e) => void toggleBridge(e.target.checked)}
                  className="accent-blue-600"
                />
                新 NAS 告警弹出桌面系统通知
              </label>
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-slate-600 hover:bg-slate-50"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                全部已读
              </button>
            </div>
          </div>

          {events.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              {loading ? "正在拉取 NAS 消息…" : "暂无消息记录"}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {events.map((ev) => (
                <div key={ev.id} className="flex items-start gap-2.5 py-2.5 text-xs">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      ev.unread ? "bg-blue-600" : "bg-slate-200"
                    }`}
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{ev.title}</span>
                      {ev.level !== "-" && (
                        <span className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-500">
                          {ev.level}
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-slate-400">{ev.time}</span>
                    </div>
                    {ev.body !== "-" && ev.body !== ev.title && (
                      <div className="text-slate-500">{ev.body}</div>
                    )}
                  </div>
                  {ev.unread && (
                    <button
                      type="button"
                      onClick={() => void markOneRead(ev.id)}
                      className="shrink-0 text-[11px] text-blue-600 hover:underline"
                    >
                      已读
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3.5 space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        {icon}
        <span>{label}</span>
      </div>
      <div className="truncate text-lg font-semibold text-slate-900">{value}</div>
      <div className="truncate text-[11px] text-slate-400">{sub}</div>
    </div>
  );
}
