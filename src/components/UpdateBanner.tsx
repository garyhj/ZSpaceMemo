import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, Sparkles, X } from "lucide-react";
import {
  formatBytesCompact,
  type ReleaseUpdateInfo,
  type UpdateProgressEvent,
} from "../utils/updater";

interface Props {
  updateInfo: ReleaseUpdateInfo;
  updateProgress: UpdateProgressEvent | null;
  installingUpdate: boolean;
  updateError: string | null;
  onDismiss: () => void;
  onInstallUpdate: (info: ReleaseUpdateInfo) => Promise<void>;
}

export function UpdateBanner({
  updateInfo,
  updateProgress,
  installingUpdate,
  updateError,
  onDismiss,
  onInstallUpdate,
}: Props) {
  return (
    <div className="fixed bottom-5 right-5 z-40 w-80 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xl space-y-2.5">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-slate-900">
            发现新版本 v{updateInfo.latest_version}
          </div>
          <div className="text-[11px] text-slate-400">
            当前 v{updateInfo.current_version}
            {(updateInfo.asset_size ?? 0) > 0
              ? ` · 包体积 ${formatBytesCompact(updateInfo.asset_size)}`
              : ""}
          </div>
        </div>
        {!installingUpdate && (
          <button
            type="button"
            title="稍后提醒"
            onClick={onDismiss}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {updateProgress && installingUpdate ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-blue-700">
            <span className="truncate">{updateProgress.message}</span>
            <span className="shrink-0 tabular-nums">
              {updateProgress.total
                ? `${updateProgress.percent}%`
                : formatBytesCompact(updateProgress.downloaded)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-150"
              style={{ width: `${Math.max(4, updateProgress.percent)}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          {updateInfo.auto_install_supported && (
            <button
              type="button"
              onClick={() => void onInstallUpdate(updateInfo)}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700"
            >
              <Download className="h-3.5 w-3.5" />
              立即应用内更新
            </button>
          )}
          <button
            type="button"
            onClick={() => void openUrl(updateInfo.release_url)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
          >
            发布页
          </button>
        </div>
      )}

      {updateError && <div className="text-[11px] text-red-500">{updateError}</div>}
    </div>
  );
}
