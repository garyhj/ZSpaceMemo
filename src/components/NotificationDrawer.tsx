import { Bell, Clock, X } from "lucide-react";
import type { NotificationRecord } from "../types";

interface Props {
  notifications: NotificationRecord[];
  onClose: () => void;
  onMarkRead: (id: number) => Promise<void>;
  onSnooze: (n: NotificationRecord, minutes: number) => Promise<void>;
  onOpenTask: (taskId: number) => void;
}

export function NotificationDrawer({
  notifications,
  onClose,
  onMarkRead,
  onSnooze,
  onOpenTask,
}: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/25"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-sm flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <Bell className="h-4 w-4 text-blue-600" />
            <span>通知中心</span>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-slate-100">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {notifications.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">暂无提醒记录</div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className={`p-3.5 text-xs space-y-1.5 ${n.read ? "bg-white" : "bg-blue-50/40"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void onMarkRead(n.id);
                      onOpenTask(n.task_id);
                      onClose();
                    }}
                    className="text-left font-medium text-sm text-slate-800 hover:text-blue-600"
                  >
                    {n.title}
                  </button>
                  {n.late && (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700">
                      补提醒
                    </span>
                  )}
                </div>
                <div className="text-slate-600">{n.body}</div>
                <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400">
                  <span>{n.fired_at_utc.slice(0, 16).replace("T", " ")}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void onSnooze(n, 10)}
                      className="inline-flex items-center gap-0.5 text-slate-500 hover:text-blue-600"
                    >
                      <Clock className="h-3 w-3" />
                      10分钟后
                    </button>
                    <button
                      type="button"
                      onClick={() => void onSnooze(n, 60)}
                      className="text-slate-500 hover:text-blue-600"
                    >
                      1小时后
                    </button>
                    {!n.read && (
                      <button
                        type="button"
                        onClick={() => void onMarkRead(n.id)}
                        className="text-blue-600 hover:underline"
                      >
                        已读
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
