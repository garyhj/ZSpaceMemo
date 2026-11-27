import type { AppSettings } from "../../types";
import {
  DEFAULT_GLOBAL_SHORTCUT,
  formatKeyComboFromEvent,
  SHORTCUT_PRESETS,
} from "./shared";

interface Props {
  settings: AppSettings;
  shortcutDraft: string;
  setShortcutDraft: (v: string) => void;
  recordingShortcut: boolean;
  setRecordingShortcut: React.Dispatch<React.SetStateAction<boolean>>;
  busy: boolean;
  setMsg: (msg: string) => void;
  saveSettingsPatch: (
    updater: (cur: AppSettings) => AppSettings,
    successMsg?: string
  ) => Promise<AppSettings | null>;
}

export function ShortcutsTab({
  settings,
  shortcutDraft,
  setShortcutDraft,
  recordingShortcut,
  setRecordingShortcut,
  busy,
  setMsg,
  saveSettingsPatch,
}: Props) {
  return (
    <div className="space-y-3 text-xs">
      <div className="space-y-2.5 rounded-xl border border-blue-200/80 bg-blue-50/50 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-semibold text-slate-800">全局呼出快捷键（悬浮窗开关）</div>
            <div className="text-[11px] text-slate-500">
              在任意应用中全局呼出 / 隐藏桌面悬浮窗，保存后立即在系统热键中生效。
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setShortcutDraft(DEFAULT_GLOBAL_SHORTCUT);
              setRecordingShortcut(false);
              void saveSettingsPatch(
                (cur) => ({ ...cur, global_shortcut: DEFAULT_GLOBAL_SHORTCUT }),
                "全局呼出快捷键已恢复默认"
              ).then((saved) => {
                if (!saved) {
                  setShortcutDraft(settings.global_shortcut ?? DEFAULT_GLOBAL_SHORTCUT);
                }
              });
            }}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            恢复默认
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setRecordingShortcut((v) => !v)}
            onBlur={() => setRecordingShortcut(false)}
            onKeyDown={(e) => {
              if (!recordingShortcut) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Escape") {
                setRecordingShortcut(false);
                return;
              }
              const combo = formatKeyComboFromEvent(e.nativeEvent);
              if (!combo) {
                setMsg("请按下包含 Ctrl / Cmd / Alt 的组合键（如 Ctrl+Shift+M）");
                return;
              }
              setShortcutDraft(combo);
              setRecordingShortcut(false);
              void saveSettingsPatch(
                (cur) => ({ ...cur, global_shortcut: combo }),
                `全局快捷键已设为 ${combo}`
              ).then((saved) => {
                if (!saved) {
                  setShortcutDraft(settings.global_shortcut ?? DEFAULT_GLOBAL_SHORTCUT);
                }
              });
            }}
            className={`min-w-[200px] rounded-lg border px-3 py-1.5 text-left font-mono text-xs transition ${
              recordingShortcut
                ? "border-blue-500 bg-white text-blue-600 ring-2 ring-blue-200"
                : "border-slate-200 bg-white text-slate-800 hover:border-blue-300"
            }`}
          >
            {recordingShortcut ? "请按下新的组合键（Esc 取消）…" : shortcutDraft}
          </button>

          {SHORTCUT_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={busy}
              onClick={() => {
                setShortcutDraft(preset);
                setRecordingShortcut(false);
                void saveSettingsPatch(
                  (cur) => ({ ...cur, global_shortcut: preset }),
                  `全局快捷键已设为 ${preset}`
                ).then((saved) => {
                  if (!saved) {
                    setShortcutDraft(settings.global_shortcut ?? DEFAULT_GLOBAL_SHORTCUT);
                  }
                });
              }}
              className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition disabled:opacity-50 ${
                (settings.global_shortcut ?? DEFAULT_GLOBAL_SHORTCUT) === preset
                  ? "border-blue-400 bg-blue-600 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[
          [settings.global_shortcut ?? DEFAULT_GLOBAL_SHORTCUT, "全局呼出 / 隐藏待办悬浮窗"],
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
            key={desc}
            className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2"
          >
            <span className="truncate text-slate-700">{desc}</span>
            <kbd className="shrink-0 rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-600 shadow-2xs">
              {k}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
