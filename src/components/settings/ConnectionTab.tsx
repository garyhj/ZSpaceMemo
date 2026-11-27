import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  Check,
  Download,
  FolderOpen,
  Globe,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Wifi,
} from "lucide-react";
import { api } from "../../api";
import type { AppSettings, AuthStatus, ConnectionMode, NasDoctorReport } from "../../types";
import {
  checkLatestRelease,
  formatBytesCompact,
  type ReleaseUpdateInfo,
  type UpdateProgressEvent,
} from "../../utils/updater";
import { confirmAction } from "../ConfirmDialog";
import { Segmented } from "./shared";

interface Props {
  auth: AuthStatus;
  settings: AppSettings;
  connMode: ConnectionMode;
  setConnMode: (v: ConnectionMode) => void;
  lanHost: string;
  setLanHost: (v: string) => void;
  allowHttp: boolean;
  setAllowHttp: (v: boolean) => void;
  cliTimeout: number;
  setCliTimeout: (v: number) => void;
  connDirty: boolean;
  isInsecureHttp: boolean;
  busy: boolean;
  diagnosing: boolean;
  installingUpdate: boolean;
  checkingUpdate: boolean;
  setCheckingUpdate: (v: boolean) => void;
  appVersion: string;
  localUpdate: ReleaseUpdateInfo | null;
  setLocalUpdate: (v: ReleaseUpdateInfo | null) => void;
  updateProgress?: UpdateProgressEvent | null;
  updateError?: string | null;
  doctorReport: NasDoctorReport | null;
  setMsg: (msg: string) => void;
  saveConnectionSettings: () => Promise<boolean>;
  handleDoctor: () => Promise<void>;
  handleInitCategory: () => Promise<void>;
  onLogout: () => Promise<void>;
  onUpdateChecked?: (info: ReleaseUpdateInfo) => void;
  onInstallUpdate?: (info: ReleaseUpdateInfo) => Promise<void>;
}

export function ConnectionTab({
  auth,
  settings,
  connMode,
  setConnMode,
  lanHost,
  setLanHost,
  allowHttp,
  setAllowHttp,
  cliTimeout,
  setCliTimeout,
  connDirty,
  isInsecureHttp,
  busy,
  diagnosing,
  installingUpdate,
  checkingUpdate,
  setCheckingUpdate,
  appVersion,
  localUpdate,
  setLocalUpdate,
  updateProgress,
  updateError,
  doctorReport,
  setMsg,
  saveConnectionSettings,
  handleDoctor,
  handleInitCategory,
  onLogout,
  onUpdateChecked,
  onInstallUpdate,
}: Props) {
  return (
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
                void (async () => {
                  if (
                    await confirmAction({
                      title: "退出极空间授权",
                      message: "确定退出当前极空间授权？",
                      confirmText: "退出授权",
                      danger: true,
                    })
                  ) {
                    await onLogout();
                  }
                })();
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

          {localUpdate?.has_update && (
            <div className="space-y-1.5 rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-blue-800">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 font-medium">
                  <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                  发现新版 v{localUpdate.latest_version}
                  {(localUpdate.asset_size ?? 0) > 0 && (
                    <span className="text-[11px] font-normal text-blue-600">
                      （{formatBytesCompact(localUpdate.asset_size)}）
                    </span>
                  )}
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
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-blue-700">
                    <span className="truncate">{updateProgress.message}</span>
                    <span className="shrink-0 tabular-nums font-medium">
                      {Math.round(updateProgress.percent)}%
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-blue-200">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all duration-150"
                      style={{ width: `${Math.max(4, updateProgress.percent)}%` }}
                    />
                  </div>
                </div>
              )}
              {updateError && <div className="text-[11px] text-red-600">{updateError}</div>}
            </div>
          )}

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
                      ? `发现新版本 v${info.latest_version}${
                          (info.asset_size ?? 0) > 0
                            ? `（${formatBytesCompact(info.asset_size)}）`
                            : ""
                        }`
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

          {/* Diagnostic / Category summary box (constant slot, no height jump) */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-medium text-slate-700">
              <span>{doctorReport ? "CLI 连接诊断结果" : "记事本分类与诊断信息"}</span>
              {doctorReport && (
                <span className={doctorReport.ok ? "text-emerald-600" : "text-red-500"}>
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
                  <pre className="select-text max-h-24 overscroll-contain overflow-auto rounded bg-slate-900 p-2 font-mono text-[10px] text-slate-200 whitespace-pre-wrap">
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
  );
}
