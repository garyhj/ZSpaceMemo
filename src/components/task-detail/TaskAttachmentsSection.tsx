import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, Loader2, Paperclip, Plus } from "lucide-react";
import type { Task, TaskAttachment } from "../../types";
import { formatBytesCompact } from "../../utils/updater";
import { confirmAction } from "../ConfirmDialog";

interface Props {
  task: Task;
  attBusy: boolean;
  setAttBusy: (busy: boolean) => void;
  onUploadAttachment?: (task: Task, localPath: string) => Promise<void>;
  onDownloadAttachment?: (task: Task, att: TaskAttachment, localDest: string) => Promise<void>;
  onRemoveAttachment?: (task: Task, fileId: string) => Promise<void>;
}

export function TaskAttachmentsSection({
  task,
  attBusy,
  setAttBusy,
  onUploadAttachment,
  onDownloadAttachment,
  onRemoveAttachment,
}: Props) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1 font-semibold text-slate-700">
          <Paperclip className="h-3.5 w-3.5 text-slate-400" />
          附件
          {(task.attachments?.length ?? 0) > 0 && (
            <span className="font-normal text-slate-400">({task.attachments!.length})</span>
          )}
        </span>
        {onUploadAttachment && (
          <button
            type="button"
            disabled={attBusy}
            title="上传待办附件（极空间笔记接口限制单个不超过 16 MB）"
            onClick={async () => {
              try {
                const picked = await open({
                  multiple: true,
                  title: "选择要上传到当前待办的附件",
                });
                if (!picked) return;
                const paths = Array.isArray(picked) ? picked : [picked];
                if (paths.length === 0) return;
                setAttBusy(true);
                for (const p of paths) {
                  await onUploadAttachment(task, p);
                }
              } catch (e) {
                console.error("Upload attachment dialog failed:", e);
              } finally {
                setAttBusy(false);
              }
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          >
            {attBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {attBusy ? "上传中…" : "上传附件"}
          </button>
        )}
      </div>

      {(task.attachments?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-1.5 divide-y divide-slate-100">
          {task.attachments!.map((att) => (
            <div key={att.file_id} className="flex items-center gap-2 py-1.5 text-xs">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-slate-700" title={att.name}>
                {att.name}
              </span>
              {att.size != null && att.size > 0 && (
                <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">
                  {formatBytesCompact(att.size)}
                </span>
              )}
              {onDownloadAttachment && (
                <button
                  type="button"
                  disabled={attBusy}
                  onClick={async () => {
                    try {
                      const dest = await save({
                        defaultPath: att.name,
                        title: `保存附件「${att.name}」`,
                      });
                      if (!dest) return;
                      setAttBusy(true);
                      await onDownloadAttachment(task, att, dest);
                    } catch (e) {
                      console.error("Download attachment dialog failed:", e);
                    } finally {
                      setAttBusy(false);
                    }
                  }}
                  className="inline-flex shrink-0 items-center gap-0.5 text-blue-600 hover:underline disabled:opacity-40"
                >
                  <Download className="h-3 w-3" />
                  下载
                </button>
              )}
              {onRemoveAttachment && (
                <button
                  type="button"
                  disabled={attBusy}
                  onClick={() => {
                    void (async () => {
                      if (
                        await confirmAction({
                          title: "解除附件关联",
                          message: `确定从待办中解除附件「${att.name}」的关联吗？\n\n受极空间 CLI 接口限制，解除后不会物理删除 NAS 云端原始附件文件。`,
                          confirmText: "解除关联",
                          danger: true,
                        })
                      ) {
                        await onRemoveAttachment(task, att.file_id);
                      }
                    })();
                  }}
                  className="shrink-0 text-slate-400 hover:text-red-500 disabled:opacity-40"
                >
                  移除
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
