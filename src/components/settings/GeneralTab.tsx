import { BellRing } from "lucide-react";
import { api } from "../../api";
import type { AppSettings } from "../../types";
import { setPrefs, type UiPrefs } from "../../utils/prefs";
import { TimePicker } from "../TimePicker";
import { Segmented } from "./shared";

interface Props {
  settings: AppSettings;
  notifPerm: "granted" | "denied" | "prompt" | "unknown";
  setNotifPerm: (v: "granted" | "denied" | "prompt" | "unknown") => void;
  permBadge: [string, string];
  prefs: UiPrefs;
  saveSettingsPatch: (
    updater: (cur: AppSettings) => AppSettings,
    successMsg?: string
  ) => Promise<AppSettings | null>;
  handleTestNotification: () => Promise<void>;
}

export function GeneralTab({
  settings,
  notifPerm,
  setNotifPerm,
  permBadge,
  prefs,
  saveSettingsPatch,
  handleTestNotification,
}: Props) {
  return (
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
              onChange={(e) => {
                const checked = e.target.checked;
                void saveSettingsPatch((cur) => ({
                  ...cur,
                  default_auto_remind: checked,
                }));
              }}
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
              onChange={(e) => {
                const checked = e.target.checked;
                void saveSettingsPatch((cur) => ({
                  ...cur,
                  notification_sound: checked,
                }));
              }}
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
              onChange={(e) => {
                const checked = e.target.checked;
                void saveSettingsPatch((cur) => ({
                  ...cur,
                  bridge_nas_events: checked,
                }));
              }}
              className="h-4 w-4 accent-blue-600"
            />
          </label>

          <label className="flex items-center justify-between gap-2">
            <span className="text-slate-700">「今天」视图顶部显示已逾期任务</span>
            <input
              type="checkbox"
              checked={settings.show_overdue_in_today}
              onChange={(e) => {
                const checked = e.target.checked;
                void saveSettingsPatch((cur) => ({
                  ...cur,
                  show_overdue_in_today: checked,
                }));
              }}
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
                if (t) {
                  void saveSettingsPatch((cur) => ({
                    ...cur,
                    default_all_day_reminder_time: t,
                  }));
                }
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-700">后台同步间隔</span>
            <select
              value={settings.sync_interval_secs}
              onChange={(e) => {
                const secs = Number(e.target.value);
                void saveSettingsPatch((cur) => ({
                  ...cur,
                  sync_interval_secs: secs,
                }));
              }}
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
                onChange={(e) => {
                  const checked = e.target.checked;
                  void saveSettingsPatch((cur) => ({
                    ...cur,
                    autostart: checked,
                  }));
                }}
                className="h-3.5 w-3.5 accent-blue-600"
              />
              开机自启动
            </label>
            <label className="flex items-center gap-1.5 text-slate-700">
              <input
                type="checkbox"
                checked={settings.close_to_tray}
                onChange={(e) => {
                  const checked = e.target.checked;
                  void saveSettingsPatch((cur) => ({
                    ...cur,
                    close_to_tray: checked,
                  }));
                }}
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
  );
}
