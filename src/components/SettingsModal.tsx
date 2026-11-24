import { LogOut, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, AuthStatus } from "../types";
import { TimePicker } from "./TimePicker";

interface Props {
  auth: AuthStatus;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings) => void;
}

export function SettingsModal({ auth, onClose, onLogout, onSettingsChanged }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch((e) => setMsg(String(e)));
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
      const refreshed = await api.getSettings();
      setSettings(refreshed);
      onSettingsChanged(refreshed);
      setMsg(`专用分类已就绪（ID: ${id}）`);
    } catch (e) {
      setMsg(`初始化失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">设置</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-slate-100">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        {/* NAS OAuth status */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-700">极空间连接（官方 OAuth2）</span>
            <span className="text-emerald-600 font-medium">● 已授权</span>
          </div>
          <div className="text-slate-500">NAS ID：{auth.nas_id ?? "未知"}</div>
          <div className="text-slate-500">
            专用分类：{settings.todo_category_name}
            {settings.todo_category_id ? ` (ID: ${settings.todo_category_id})` : "（未初始化）"}
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

        {/* Preferences */}
        <div className="space-y-3 text-sm">
          <label className="flex items-center justify-between">
            <div>
              <div className="text-slate-800">开机自启动</div>
              <div className="text-xs text-slate-400">保持托盘常驻，按时弹出提醒并自动补提醒</div>
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

        {msg && <div className="text-xs text-blue-600">{msg}</div>}
      </div>
    </div>
  );
}
