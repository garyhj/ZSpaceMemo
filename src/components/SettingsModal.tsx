import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BellRing, Download, FolderOpen, LogOut, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, AuthStatus } from "../types";
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
  onClose,
  onLogout,
  onSettingsChanged,
}: Props) {
  const prefs = usePrefs();
  const [tab, setTab] = useState<"general" | "shortcuts">("general");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notifPerm, setNotifPerm] = useState<"granted" | "denied" | "prompt" | "unknown">("unknown");
  const [appVersion, setAppVersion] = useState("0.4.2");
  const [localUpdate, setLocalUpdate] = useState<ReleaseUpdateInfo | null>(updateInfo ?? null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setLocalUpdate(updateInfo ?? null);
  }, [updateInfo]);

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
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

  async function save(next: AppSettings) {
    setBusy(true);
    setMsg("");
    try {
      await api.saveSettings(next);
      if (next.autostart !== settings?.autostart) {
        await api.setAutostart(next.autostart).catch(() => {});
      }
      setSettings(next);
      onSettingsChanged(next);
      setMsg("设置已保存");
    } catch (e) {
      setMsg(`保存失败：${String(e)}`);
    } finally {
      setBusy(false);
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
                ["shortcuts", "快捷键"],
              ]}
              onChange={(v) => setTab(v as "general" | "shortcuts")}
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

        {/* Stable Content Body (fits cleanly without scrollbar on normal sizes; gutter reserved if small viewport) */}
        <div className="min-h-[390px] flex-1 overflow-y-auto px-5 py-3.5 [scrollbar-gutter:stable]">
          {tab === "shortcuts" ? (
            <div className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
              {[
                ["Ctrl / Cmd + Shift + M", "全局呼出 / 隐藏待办悬浮窗"],
                ["Alt / Option + 1 ~ 6", "切换 待办/月视图/便签/快传/NAS/Docker"],
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
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {/* Top-left: NAS OAuth status */}
              <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs space-y-2">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700">极空间连接（OAuth2）</span>
                    <span className="font-medium text-emerald-600">● 已授权</span>
                  </div>
                  <div className="truncate text-slate-500">NAS ID：{auth.nas_id ?? "未知"}</div>
                  <div className="truncate text-slate-500">
                    待办：{settings.todo_category_name}
                    {settings.todo_category_id ? ` (#${settings.todo_category_id})` : " (未建)"}
                    {" · "}便签：{settings.sticky_category_name}
                    {settings.sticky_category_id ? ` (#${settings.sticky_category_id})` : " (未建)"}
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-0.5">
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

              {/* Top-right: Version & Diagnostics */}
              <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs space-y-2">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700">版本与诊断日志</span>
                    <span className="font-mono text-[11px] text-slate-500">v{appVersion}</span>
                  </div>
                  <div className="text-slate-400">
                    滚动日志自动脱敏 · 支持 GitHub Releases 应用内更新
                  </div>
                </div>

                {localUpdate?.has_update ? (
                  <div className="space-y-1.5 rounded-lg border border-blue-200 bg-blue-50 p-2 text-blue-800">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 font-medium">
                        <Sparkles className="h-3 w-3 text-blue-600" />
                        新版 v{localUpdate.latest_version}
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
                  <div className="flex items-center gap-2 pt-0.5">
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
                              ? `发现新版本 v${info.latest_version}（${formatBytesCompact(info.asset_size)}），点击右上「立即更新」安装`
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
              </div>

              {/* Bottom-left: OS Notifications */}
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs space-y-2.5">
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

              {/* Bottom-right: Preferences */}
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs space-y-2.5">
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

                <div className="flex items-center justify-between gap-4 pt-0.5">
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
            </div>
          )}
        </div>

        {/* Fixed-Height Footer (eliminates modal height jumps when msg appears) */}
        <div className="flex h-9 shrink-0 items-center justify-between border-t border-slate-100 bg-slate-50/70 px-5 text-xs">
          <span className={`truncate ${msg.includes("失败") ? "text-red-500" : msg ? "text-blue-600" : "text-slate-400"}`}>
            {msg || "所有配置实时保存在本地，任务与便签数据源仍在极空间 NAS"}
          </span>
          {localUpdate?.has_update && (
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
          )}
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
