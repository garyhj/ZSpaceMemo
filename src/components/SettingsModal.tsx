import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  BellRing,
  Check,
  Download,
  FolderOpen,
  Globe,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Wifi,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, AuthStatus, ConnectionMode, NasDoctorReport } from "../types";
import { setPrefs, usePrefs } from "../utils/prefs";
import {
  checkLatestRelease,
  formatBytesCompact,
  type ReleaseUpdateInfo,
  type UpdateProgressEvent,
} from "../utils/updater";
import { TimePicker } from "./TimePicker";

interface Props {
  auth: AuthStatus;
  updateInfo?: ReleaseUpdateInfo | null;
  updateProgress?: UpdateProgressEvent | null;
  installingUpdate?: boolean;
  updateError?: string | null;
  onUpdateChecked?: (info: ReleaseUpdateInfo) => void;
  onInstallUpdate?: (info: ReleaseUpdateInfo) => Promise<void>;
  onAuthRefreshed?: (auth: AuthStatus) => void;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings) => void;
}

export function SettingsModal({
  auth,
  updateInfo,
  updateProgress,
  installingUpdate = false,
  updateError,
  onUpdateChecked,
  onInstallUpdate,
  onAuthRefreshed,
  onClose,
  onLogout,
  onSettingsChanged,
}: Props) {
  const prefs = usePrefs();
  const [tab, setTab] = useState<"general" | "connection" | "shortcuts">(
    updateInfo?.has_update ? "connection" : "general"
  );
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notifPerm, setNotifPerm] = useState<"granted" | "denied" | "prompt" | "unknown">("unknown");
  const [appVersion, setAppVersion] = useState("0.7.0");
  const [localUpdate, setLocalUpdate] = useState<ReleaseUpdateInfo | null>(updateInfo ?? null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const [connMode, setConnMode] = useState<ConnectionMode>("auto");
  const [lanHost, setLanHost] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [cliTimeout, setCliTimeout] = useState(30);
  const [diagnosing, setDiagnosing] = useState(false);
  const [doctorReport, setDoctorReport] = useState<NasDoctorReport | null>(null);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setLocalUpdate(updateInfo ?? null);
  }, [updateInfo]);

  function syncConnectionDraft(cfg: AppSettings) {
    setConnMode(cfg.connection_mode ?? "auto");
    setLanHost(cfg.lan_host ?? "");
    setAllowHttp(Boolean(cfg.allow_insecure_http));
    setCliTimeout(cfg.cli_timeout_secs ?? 30);
  }

  useEffect(() => {
    api
      .getSettings()
      .then((cfg) => {
        setSettings(cfg);
        syncConnectionDraft(cfg);
      })
      .catch((e) => setMsg(String(e)));
    api
      .notificationPermissionState()
      .then(setNotifPerm)
      .catch(() => setNotifPerm("unknown"));
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  if (!settings) return null;

  async function save(next: AppSettings, successMsg = "设置已保存"): Promise<AppSettings | null> {
    setBusy(true);
    setMsg("");
    try {
      await api.saveSettings(next);
      if (next.autostart !== settings?.autostart) {
        await api.setAutostart(next.autostart).catch(() => {});
      }
      const refreshed = await api.getSettings().catch(() => next);
      setSettings(refreshed);
      syncConnectionDraft(refreshed);
      onSettingsChanged(refreshed);
      const nextAuth = await api.authStatus().catch(() => null);
      if (nextAuth) onAuthRefreshed?.(nextAuth);
      setMsg(successMsg);
      return refreshed;
    } catch (e) {
      setMsg(`保存失败：${String(e)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const connDirty =
    connMode !== (settings.connection_mode ?? "auto") ||
    lanHost.trim().replace(/\/+$/, "") !== (settings.lan_host ?? "") ||
    allowHttp !== Boolean(settings.allow_insecure_http) ||
    cliTimeout !== (settings.cli_timeout_secs ?? 30);

  async function saveConnectionSettings(): Promise<boolean> {
    if (!settings) return false;
    const saved = await save(
      {
        ...settings,
        connection_mode: connMode,
        lan_host: lanHost.trim() || null,
        allow_insecure_http: allowHttp,
        cli_timeout_secs: cliTimeout,
      },
      connMode === "lan"
        ? `已启用 LAN 内网直连：${lanHost.trim()}`
        : connMode === "cloud"
        ? "已切换为云代理模式 (cloud)"
        : "已切换为自动连接模式 (auto)"
    );
    return Boolean(saved);
  }

  async function handleDoctor() {
    if (!settings) return;
    setDiagnosing(true);
    setMsg("");
    try {
      if (connDirty) {
        const ok = await saveConnectionSettings();
        if (!ok) return;
      }
      const report = await api.nasDoctor();
      setDoctorReport(report);
      const nextAuth = await api.authStatus().catch(() => null);
      if (nextAuth) onAuthRefreshed?.(nextAuth);
      setMsg(
        report.ok
          ? `连接诊断通过（耗时 ${report.latency_ms}ms）`
          : `连接诊断异常：${report.error ?? "请检查网络或直连地址"}`
      );
    } catch (e) {
      setMsg(`诊断失败：${String(e)}`);
    } finally {
      setDiagnosing(false);
    }
  }

  async function handleInitCategory() {
    setBusy(true);
    try {
      const id = await api.initializeCategory(true);
      await api.initStickyCategory(true).catch(() => 0);
      const refreshed = await api.getSettings();
      setSettings(refreshed);
      onSettingsChanged(refreshed);
      setMsg(`待办与便签分类已就绪（待办分类 ID: ${id}）`);
    } catch (e) {
      setMsg(`初始化失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleTestNotification() {
    setMsg("");
    try {
      if (notifPerm === "prompt") {
        const next = await api.requestNotificationPermission();
        setNotifPerm(next);
      }
      await api.sendTestNotification();
      setMsg("已发送系统测试通知（若未弹出请检查系统勿扰/专注模式与通知权限）");
    } catch (e) {
      setMsg(`发送系统通知失败：${String(e)}`);
    }
  }

  const permBadge =
    notifPerm === "granted"
      ? ["已允许通知", "text-emerald-600"]
      : notifPerm === "denied"
      ? ["系统权限被拒", "text-red-500"]
      : notifPerm === "prompt"
      ? ["未授权通知", "text-amber-600"]
      : ["系统原生通知", "text-slate-500"];

  const isInsecureHttp = lanHost.trim().toLowerCase().startsWith("http://");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Fixed Modal Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-slate-900">设置</h2>
            <Segmented
              value={tab}
              options={[
                ["general", "常规"],
                ["connection", localUpdate?.has_update ? "连接与更新 ●" : "连接与更新"],
                ["shortcuts", "快捷键"],
              ]}
              onChange={(v) => setTab(v as "general" | "connection" | "shortcuts")}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Fixed-Height Content Area (prevents layout jitter across tabs) */}
        <div className="h-[420px] max-h-[calc(92vh-96px)] overflow-y-auto px-5 py-3.5 [scrollbar-gutter:stable]">
          {tab === "shortcuts" ? (
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              {[
                ["Ctrl / Cmd + Shift + M", "全局呼出 / 隐藏待办悬浮窗"],
                ["Alt / Option + 1 ~ 7", "切换 待办/月视图/便签/快传/NAS/Docker/下载器"],
                ["Ctrl / Cmd + K 或 /", "聚焦搜索框"],
                ["N", "快速新建任务"],
                ["↑ / ↓", "上下切换选中任务"],
                ["Space 或 Ctrl / Cmd + Enter", "完成 / 重新打开选中任务"],
                ["Delete", "删除选中任务"],
                ["1 / 2 / 3 / 4", "切换 今天 / 即将到来 / 收集箱 / 全部"],
                ["Esc", "关闭弹窗、菜单或取消选中"],
              ].map(([k, desc]) => (
                <div
                  key={k}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2"
                >
                  <span className="truncate text-slate-700">{desc}</span>
                  <kbd className="shrink-0 rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-600 shadow-2xs">
                    {k}
                  </kbd>
                </div>
              ))}
            </div>
          ) : tab === "connection" ? (
            <div className="grid h-full grid-cols-1 gap-3 md:grid-cols-2">
              {/* Left card: NAS OAuth & LAN Direct */}
              <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 text-xs space-y-2.5">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                      {connMode === "lan" ? (
                        <Wifi className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Globe className="h-3.5 w-3.5 text-blue-600" />
                      )}
                      极空间连接与内网直连
                    </span>
                    <span className="font-medium text-emerald-600">
                      ● {auth.mode === "lan" ? "LAN 直连" : "已授权"}
                    </span>
                  </div>

                  <div className="flex items-center justify-between rounded-lg bg-white px-2.5 py-1.5 text-[11px] text-slate-500 border border-slate-200/80">
                    <span className="truncate">NAS：{auth.nas_id ?? "未知"}</span>
                    <span className="shrink-0 font-mono text-slate-400">
                      当前：{auth.mode ?? "auto"}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">连接模式</span>
                    <Segmented
                      value={connMode}
                      options={[
                        ["auto", "自动"],
                        ["cloud", "云代理"],
                        ["lan", "LAN 直连"],
                      ]}
                      onChange={(v) => setConnMode(v as ConnectionMode)}
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[11px] text-slate-600">
                      固定内网 NAS 地址（局域网直连可大幅提速）
                    </label>
                    <input
                      value={lanHost}
                      onChange={(e) => setLanHost(e.target.value)}
                      placeholder="https://192.168.1.2:5056 或 http://192.168.1.2:5055"
                      disabled={connMode !== "lan"}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-blue-400 disabled:bg-slate-100 disabled:text-slate-400"
                    />
                    {connMode === "lan" && isInsecureHttp && (
                      <label className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/80 px-2 py-1.5 text-[11px] text-amber-800">
                        <input
                          type="checkbox"
                          checked={allowHttp}
                          onChange={(e) => setAllowHttp(e.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-amber-600"
                        />
                        <span>
                          允许不安全 HTTP 内网直连（同网段存在明文传输风险，优先推荐 HTTPS）
                        </span>
                      </label>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">普通请求超时</span>
                    <select
                      value={cliTimeout}
                      onChange={(e) => setCliTimeout(Number(e.target.value))}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                    >
                      <option value={15}>15 秒（内网快速）</option>
                      <option value={30}>30 秒（默认）</option>
                      <option value={60}>60 秒</option>
                      <option value={120}>120 秒</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2 border-t border-slate-200/80 pt-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy || diagnosing}
                      onClick={() => void saveConnectionSettings()}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" />
                      {connDirty ? "应用连接设置*" : "保存连接"}
                    </button>
                    <button
                      type="button"
                      disabled={diagnosing || busy}
                      onClick={() => void handleDoctor()}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    >
                      <Activity className={`h-3.5 w-3.5 ${diagnosing ? "animate-pulse text-blue-600" : ""}`} />
                      {diagnosing ? "诊断中…" : "连接诊断"}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleInitCategory()}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-slate-700 hover:bg-slate-100"
                    >
                      <RefreshCw className="h-3 w-3" />
                      检查分类
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm("确定退出当前极空间授权？")) {
                          void onLogout();
                        }
                      }}
                      className="ml-auto inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-red-600 hover:bg-red-50"
                    >
                      <LogOut className="h-3 w-3" />
                      退出授权
                    </button>
                  </div>
                </div>
              </div>

              {/* Right card: Doctor Result, Version & Logs */}
              <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 text-xs space-y-2.5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">版本与诊断状态</span>
                    <span className="font-mono text-[11px] text-slate-500">v{appVersion}</span>
                  </div>

                  {localUpdate?.has_update ? (
                    <div className="space-y-1.5 rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-blue-800">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1 font-medium">
                          <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                          发现新版 v{localUpdate.latest_version}
                        </span>
                        <div className="flex items-center gap-1">
                          {localUpdate.auto_install_supported && onInstallUpdate && (
                            <button
                              type="button"
                              disabled={installingUpdate}
                              onClick={() => void onInstallUpdate(localUpdate)}
                              className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                            >
                              <Download className="h-3 w-3" />
                              {installingUpdate ? "更新中…" : "立即更新"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void openUrl(localUpdate.release_url)}
                            className="rounded border border-blue-200 bg-white px-1.5 py-0.5 text-[11px] text-blue-700 hover:bg-blue-100"
                          >
                            详情
                          </button>
                        </div>
                      </div>
                      {updateProgress && installingUpdate && (
                        <div className="h-1.5 overflow-hidden rounded-full bg-blue-200">
                          <div
                            className="h-full rounded-full bg-blue-600 transition-all duration-150"
                            style={{ width: `${Math.max(4, updateProgress.percent)}%` }}
                          />
                        </div>
                      )}
                      {updateError && <div className="text-[11px] text-red-600">{updateError}</div>}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-2">
                      <button
                        type="button"
                        disabled={checkingUpdate || installingUpdate}
                        onClick={async () => {
                          setCheckingUpdate(true);
                          setMsg("");
                          try {
                            const info = await checkLatestRelease();
                            setLocalUpdate(info);
                            onUpdateChecked?.(info);
                            setMsg(
                              info.has_update
                                ? `发现新版本 v${info.latest_version}（${formatBytesCompact(info.asset_size)}）`
                                : `当前 v${appVersion} 已是最新版本`
                            );
                          } catch (e) {
                            setMsg(`检查更新失败：${String(e)}`);
                          } finally {
                            setCheckingUpdate(false);
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                      >
                        <RefreshCw className={`h-3 w-3 ${checkingUpdate ? "animate-spin" : ""}`} />
                        检查更新
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const dir = await api.openLogsDir();
                            setMsg(`已打开日志目录：${dir}`);
                          } catch (e) {
                            setMsg(`打开日志目录失败：${String(e)}`);
                          }
                        }}
                        className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-slate-700 hover:bg-slate-100"
                      >
                        <FolderOpen className="h-3 w-3" />
                        日志目录
                      </button>
                    </div>
                  )}

                  {/* Diagnostic / Category summary box (constant slot, no height jump) */}
                  <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-medium text-slate-700">
                      <span>{doctorReport ? "CLI 连接诊断结果" : "记事本分类与诊断信息"}</span>
                      {doctorReport && (
                        <span
                          className={
                            doctorReport.ok ? "text-emerald-600" : "text-red-500"
                          }
                        >
                          {doctorReport.ok
                            ? `正常 · ${doctorReport.latency_ms}ms`
                            : `异常 · ${doctorReport.latency_ms}ms`}
                        </span>
                      )}
                    </div>
                    {doctorReport ? (
                      <div className="space-y-1 text-[11px] text-slate-600">
                        <div className="truncate">
                          模式：{doctorReport.effective_mode ?? doctorReport.configured_mode}
                          {doctorReport.effective_host || doctorReport.configured_host
                            ? ` · ${doctorReport.effective_host ?? doctorReport.configured_host}`
                            : " · 官方云代理"}
                        </div>
                        {doctorReport.error ? (
                          <div className="line-clamp-3 break-all rounded bg-red-50 px-2 py-1 text-red-600">
                            {doctorReport.error}
                          </div>
                        ) : (
                          <pre className="select-text max-h-24 overflow-auto rounded bg-slate-900 p-2 font-mono text-[10px] text-slate-200 whitespace-pre-wrap">
                            {JSON.stringify(doctorReport.details, null, 2)}
                          </pre>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-1 text-[11px] text-slate-500">
                        <div>
                          待办：{settings.todo_category_name}
                          {settings.todo_category_id ? ` (#${settings.todo_category_id})` : " (未建)"}
                          {" · "}便签：{settings.sticky_category_name}
                          {settings.sticky_category_id ? ` (#${settings.sticky_category_id})` : " (未建)"}
                        </div>
                        <div className="text-slate-400">
                          • 文件快传箱自动保障至少 300s 传输超时。
                        </div>
                        <div className="inline-flex items-start gap-1 text-slate-400">
                          <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>在外移动办公请切回「自动」，在家可切换「LAN 直连」。</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="text-[11px] text-slate-400">
                  滚动日志已自动脱敏 · 安装包更新启用 SHA-256 校验
                </div>
              </div>
            </div>
          ) : (
            <div className="grid h-full grid-cols-1 gap-3 md:grid-cols-2">
              {/* Left: OS Notifications */}
              <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 text-xs space-y-2.5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <BellRing className="h-3.5 w-3.5 text-blue-600" />
                      <span className="font-semibold text-slate-700">系统原生提醒</span>
                      <span className={permBadge[1]}>· {permBadge[0]}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {notifPerm === "prompt" && (
                        <button
                          type="button"
                          onClick={() =>
                            void api.requestNotificationPermission().then(setNotifPerm).catch(() => {})
                          }
                          className="rounded border border-blue-200 bg-white px-2 py-0.5 text-blue-600 hover:bg-blue-50"
                        >
                          授权
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleTestNotification()}
                        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-slate-700 hover:bg-slate-100"
                      >
                        测试通知
                      </button>
                    </div>
                  </div>

                  <label className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-slate-700">设置日期后自动开启提醒</div>
                      <div className="text-[11px] text-slate-400">全天默认时刻，具体时间默认准点</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.default_auto_remind}
                      onChange={(e) =>
                        void save({ ...settings, default_auto_remind: e.target.checked })
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-slate-700">系统通知提示音</div>
                      <div className="text-[11px] text-slate-400">关闭后改为静音横幅</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.notification_sound}
                      onChange={(e) =>
                        void save({ ...settings, notification_sound: e.target.checked })
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-slate-700">桥接极空间 NAS 系统告警</div>
                      <div className="text-[11px] text-slate-400">新安全/存储事件自动弹窗提醒</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.bridge_nas_events}
                      onChange={(e) =>
                        void save({ ...settings, bridge_nas_events: e.target.checked })
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">「今天」视图顶部显示已逾期任务</span>
                    <input
                      type="checkbox"
                      checked={settings.show_overdue_in_today}
                      onChange={(e) =>
                        void save({ ...settings, show_overdue_in_today: e.target.checked })
                      }
                      className="h-4 w-4 accent-blue-600"
                    />
                  </label>
                </div>

                <div className="border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                  关机错过的待办提醒会在下次联网同步后自动补发
                </div>
              </div>

              {/* Right: Preferences */}
              <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 text-xs space-y-2.5">
                <div className="space-y-3">
                  <div className="font-semibold text-slate-700">显示、窗口与同步</div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">时间格式</span>
                    <Segmented
                      value={prefs.timeFormat}
                      options={[
                        ["24h", "24 小时"],
                        ["12h", "12 小时"],
                      ]}
                      onChange={(v) => setPrefs({ timeFormat: v as "24h" | "12h" })}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">每周起始日</span>
                    <Segmented
                      value={prefs.weekStart}
                      options={[
                        ["mon", "周一"],
                        ["sun", "周日"],
                      ]}
                      onChange={(v) => setPrefs({ weekStart: v as "mon" | "sun" })}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">全天任务默认提醒</span>
                    <TimePicker
                      value={settings.default_all_day_reminder_time}
                      allowClear={false}
                      onChange={(t) => {
                        if (t) void save({ ...settings, default_all_day_reminder_time: t });
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">后台同步间隔</span>
                    <select
                      value={settings.sync_interval_secs}
                      onChange={(e) =>
                        void save({ ...settings, sync_interval_secs: Number(e.target.value) })
                      }
                      className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                    >
                      <option value={60}>每 1 分钟</option>
                      <option value={180}>每 3 分钟</option>
                      <option value={300}>每 5 分钟（默认）</option>
                      <option value={600}>每 10 分钟</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between gap-4 pt-1">
                    <label className="flex items-center gap-1.5 text-slate-700">
                      <input
                        type="checkbox"
                        checked={settings.autostart}
                        onChange={(e) => void save({ ...settings, autostart: e.target.checked })}
                        className="h-3.5 w-3.5 accent-blue-600"
                      />
                      开机自启动
                    </label>
                    <label className="flex items-center gap-1.5 text-slate-700">
                      <input
                        type="checkbox"
                        checked={settings.close_to_tray}
                        onChange={(e) => void save({ ...settings, close_to_tray: e.target.checked })}
                        className="h-3.5 w-3.5 accent-blue-600"
                      />
                      关闭时隐藏到托盘
                    </label>
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                  主窗、悬浮待办与桌面便利贴位置尺寸自动记忆
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Fixed-Height Footer */}
        <div className="flex h-9 shrink-0 items-center justify-between border-t border-slate-100 bg-slate-50/70 px-5 text-xs">
          <span
            className={`truncate ${
              msg.includes("失败") || msg.includes("异常")
                ? "text-red-500"
                : msg
                ? "text-blue-600"
                : "text-slate-400"
            }`}
          >
            {msg || "所有配置实时保存在本地，任务与便签数据源仍在极空间 NAS"}
          </span>
          <button
            type="button"
            onClick={async () => {
              try {
                const dir = await api.openLogsDir();
                setMsg(`已打开日志目录：${dir}`);
              } catch (e) {
                setMsg(`打开日志目录失败：${String(e)}`);
              }
            }}
            className="ml-3 shrink-0 text-[11px] text-slate-500 hover:text-slate-700 hover:underline"
          >
            打开日志目录
          </button>
        </div>
      </div>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 transition ${
            value === v ? "bg-white font-medium text-blue-600 shadow-xs" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
