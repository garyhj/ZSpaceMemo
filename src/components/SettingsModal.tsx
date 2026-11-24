import { LogOut, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, AuthStatus } from "../types";
import { setPrefs, usePrefs } from "../utils/prefs";
import { TimePicker } from "./TimePicker";

interface Props {
  auth: AuthStatus;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onSettingsChanged: (settings: AppSettings) => void;
}

export function SettingsModal({ auth, onClose, onLogout, onSettingsChanged }: Props) {
  const prefs = usePrefs();
  const [tab, setTab] = useState<"general" | "shortcuts">("general");
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
              ["Ctrl / Cmd + Shift + M", "全局呼出 / 隐藏悬浮窗"],
              ["Ctrl / Cmd + K 或 /", "聚焦搜索框"],
              ["N", "快速新建任务"],
              ["↑ / ↓", "上下切换选中任务"],
              ["Space 或 Ctrl / Cmd + Enter", "完成 / 重新打开选中任务"],
              ["Delete", "删除选中任务"],
              ["1 / 2 / 3 / 4", "切换 今天 / 即将到来 / 收集箱 / 全部"],
              ["Ctrl / Cmd + 1 / 2", "切换 任务视图 / 月视图"],
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
