import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BellRing, FolderOpen, LogOut, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, AuthStatus } from "../types";
import { setPrefs, usePrefs } from "../utils/prefs";
import { checkLatestRelease, type ReleaseUpdateInfo } from "../utils/updater";
import { TimePicker } from "./TimePicker";

interface Props {
  auth: AuthStatus;
  updateInfo?: ReleaseUpdateInfo | null;
  onUpdateChecked?: (info: ReleaseUpdateInfo) => void;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings) => void;
}

export function SettingsModal({
  auth,
  updateInfo,
  onUpdateChecked,
  onClose,
  onLogout,
  onSettingsChanged,
}: Props) {
  const prefs = usePrefs();
  const [tab, setTab] = useState<"general" | "shortcuts">("general");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notifPerm, setNotifPerm] = useState<"granted" | "denied" | "prompt" | "unknown">("unknown");
  const [appVersion, setAppVersion] = useState("0.4.0");
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
      ? ["系统通知已允许", "text-emerald-600"]
      : notifPerm === "denied"
      ? ["系统通知被拒绝（请在系统设置开启）", "text-red-500"]
      : notifPerm === "prompt"
      ? ["未授权系统通知", "text-amber-600"]
      : ["桌面系统通知", "text-slate-500"];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold">设置</h2>
            <Segmented
              value={tab}
              options={[
                ["general", "常规"],
                ["shortcuts", "快捷键"],
              ]}
              onChange={(v) => setTab(v as "general" | "shortcuts")}
            />
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-slate-100">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        {tab === "shortcuts" ? (
          <div className="space-y-1.5 text-xs">
            {[
              ["Ctrl / Cmd + Shift + M", "全局呼出 / 隐藏待办悬浮窗"],
              ["Alt / Option + 1 ~ 6", "切换 待办 / 月视图 / 便签 / 快传箱 / NAS / Docker"],
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
                className="flex items-center justify-between rounded-lg px-2.5 py-2 odd:bg-slate-50"
              >
                <span className="text-slate-700">{desc}</span>
                <kbd className="rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-600 shadow-2xs">
                  {k}
                </kbd>
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* NAS OAuth status */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-700">极空间连接（官方 OAuth2）</span>
                <span className="font-medium text-emerald-600">● 已授权</span>
              </div>
              <div className="text-slate-500">NAS ID：{auth.nas_id ?? "未知"}</div>
              <div className="text-slate-500">
                待办分类：{settings.todo_category_name}
                {settings.todo_category_id ? ` (#${settings.todo_category_id})` : "（待初始化）"}
                {" · "}
                便签分类：{settings.sticky_category_name}
                {settings.sticky_category_id ? ` (#${settings.sticky_category_id})` : "（待初始化）"}
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleInitCategory()}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-slate-700 hover:bg-slate-100"
                >
                  <RefreshCw className="h-3 w-3" />
                  检查 / 创建专用分类
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

            {/* OS System Notifications */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <BellRing className="h-3.5 w-3.5 text-blue-600" />
                  <span className="font-medium text-slate-700">系统原生提醒</span>
                  <span className={permBadge[1]}>· {permBadge[0]}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {notifPerm === "prompt" && (
                    <button
                      type="button"
                      onClick={() =>
                        void api.requestNotificationPermission().then(setNotifPerm).catch(() => {})
                      }
                      className="rounded-md border border-blue-200 bg-white px-2 py-0.5 text-blue-600 hover:bg-blue-50"
                    >
                      允许权限
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleTestNotification()}
                    className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-slate-700 hover:bg-slate-100"
                  >
                    发送测试通知
                  </button>
                </div>
              </div>

              <label className="flex items-center justify-between">
                <span className="text-slate-700">新建带日期/时间任务时自动开启「到期提醒」</span>
                <input
                  type="checkbox"
                  checked={settings.default_auto_remind}
                  onChange={(e) =>
                    void save({ ...settings, default_auto_remind: e.target.checked })
                  }
                  className="h-4 w-4 accent-blue-600"
                />
              </label>

              <label className="flex items-center justify-between">
                <span className="text-slate-700">将新 NAS 告警同步弹出系统通知</span>
                <input
                  type="checkbox"
                  checked={settings.bridge_nas_events}
                  onChange={(e) =>
                    void save({ ...settings, bridge_nas_events: e.target.checked })
                  }
                  className="h-4 w-4 accent-blue-600"
                />
              </label>

              <label className="flex items-center justify-between">
                <span className="text-slate-700">系统通知提示音</span>
                <input
                  type="checkbox"
                  checked={settings.notification_sound}
                  onChange={(e) =>
                    void save({ ...settings, notification_sound: e.target.checked })
                  }
                  className="h-4 w-4 accent-blue-600"
                />
              </label>
            </div>

            {/* Preferences */}
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-slate-800">时间格式</div>
                  <div className="text-xs text-slate-400">仅影响本机显示，不改动极空间里的数据</div>
                </div>
                <Segmented
                  value={prefs.timeFormat}
                  options={[
                    ["24h", "24 小时 18:00"],
                    ["12h", "12 小时 下午 6:00"],
                  ]}
                  onChange={(v) => setPrefs({ timeFormat: v as "24h" | "12h" })}
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-800">每周起始日</span>
                <Segmented
                  value={prefs.weekStart}
                  options={[
                    ["mon", "周一"],
                    ["sun", "周日"],
                  ]}
                  onChange={(v) => setPrefs({ weekStart: v as "mon" | "sun" })}
                />
              </div>

              <label className="flex items-center justify-between">
                <div>
                  <div className="text-slate-800">开机自启动</div>
                  <div className="text-xs text-slate-400">保持托盘常驻，按时调用系统通知并补发漏响</div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.autostart}
                  onChange={(e) => void save({ ...settings, autostart: e.target.checked })}
                  className="h-4 w-4 accent-blue-600"
                />
              </label>

              <label className="flex items-center justify-between">
                <div>
                  <div className="text-slate-800">关闭窗口时隐藏到托盘</div>
                  <div className="text-xs text-slate-400">可用快捷键 Ctrl/Cmd + Shift + M 呼出悬浮窗</div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.close_to_tray}
                  onChange={(e) => void save({ ...settings, close_to_tray: e.target.checked })}
                  className="h-4 w-4 accent-blue-600"
                />
              </label>

              <label className="flex items-center justify-between">
                <span className="text-slate-800">「今天」视图顶部显示已逾期任务</span>
                <input
                  type="checkbox"
                  checked={settings.show_overdue_in_today}
                  onChange={(e) =>
                    void save({ ...settings, show_overdue_in_today: e.target.checked })
                  }
                  className="h-4 w-4 accent-blue-600"
                />
              </label>

              <div className="flex items-center justify-between">
                <span className="text-slate-800">全天任务默认提醒时刻</span>
                <TimePicker
                  value={settings.default_all_day_reminder_time}
                  allowClear={false}
                  onChange={(t) => {
                    if (t) void save({ ...settings, default_all_day_reminder_time: t });
                  }}
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-800">后台同步间隔</span>
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
            </div>

            {/* Version & Diagnostics */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-2.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-slate-800">版本与诊断日志</div>
                  <div className="text-xs text-slate-400">
                    当前版本 v{appVersion} · 日志自动脱敏保存于本地
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={checkingUpdate}
                    onClick={async () => {
                      setCheckingUpdate(true);
                      setMsg("");
                      try {
                        const info = await checkLatestRelease(appVersion);
                        setLocalUpdate(info);
                        onUpdateChecked?.(info);
                        setMsg(
                          info.hasUpdate
                            ? `发现新版本 v${info.latestVersion}，可点击前往 GitHub Releases 下载`
                            : `当前 v${appVersion} 已是最新版本`
                        );
                      } catch (e) {
                        setMsg(`检查更新失败：${String(e)}`);
                      } finally {
                        setCheckingUpdate(false);
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
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
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                  >
                    <FolderOpen className="h-3 w-3" />
                    打开日志目录
                  </button>
                </div>
              </div>

              {localUpdate?.hasUpdate && (
                <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Sparkles className="h-3.5 w-3.5" />
                    新版本 v{localUpdate.latestVersion} 已发布
                  </span>
                  <button
                    type="button"
                    onClick={() => void openUrl(localUpdate.url)}
                    className="rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700"
                  >
                    前往下载
                  </button>
                </div>
              )}
            </div>

            {msg && <div className="text-xs text-blue-600">{msg}</div>}
          </>
        )}
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
