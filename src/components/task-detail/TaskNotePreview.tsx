import type { Task } from "../../types";
import {
  describeRepeatZh,
  type effectiveDue,
  PRIORITY_META,
  reminderLabel,
} from "../../utils/date";
import { formatTime, type UiPrefs } from "../../utils/prefs";

interface Props {
  task: Task;
  due: ReturnType<typeof effectiveDue>;
  done: boolean;
  prefs: UiPrefs;
}

export function TaskNotePreview({ task, due, done, prefs }: Props) {
  const pri = PRIORITY_META[task.priority];

  return (
    <div className="flex-1 overscroll-contain overflow-y-auto p-4 space-y-3">
      <p className="text-xs text-slate-500">
        以下是该任务保存在极空间原生记事本（<code>location="2"</code>）中的可读摘要与末尾数据块结构：
      </p>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm space-y-2">
        <h1 className="text-lg font-bold">{task.title}</h1>
        {due && (
          <p className="text-slate-700">
            📅 截止 {due.date}{" "}
            {!due.all_day && due.time ? formatTime(due.time, prefs.timeFormat) : "（全天）"}
          </p>
        )}
        <p className="text-slate-700">
          {[
            task.repeat ? `🔁 ${describeRepeatZh(task.repeat)}` : null,
            task.reminders.length > 0
              ? `⏰ ${task.reminders.map(reminderLabel).join("、")}`
              : null,
            `优先级：${pri.label}`,
            task.list ? `清单：${task.list}` : null,
            (task.attachments?.length ?? 0) > 0
              ? `📎 附件 ${task.attachments!.length} 个（${task.attachments!
                  .slice(0, 3)
                  .map((a) => a.name)
                  .join("、")}${task.attachments!.length > 3 ? "…" : ""}）`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="text-slate-700">
          状态：{done ? (task.repeat ? "已结束" : "已完成") : "待办"}
          {task.series && !done ? ` · 本次 ${task.series.cursor}` : ""}
        </p>
        <hr className="border-slate-200" />
        <div className="whitespace-pre-wrap text-slate-800">
          {task.description || <span className="text-slate-400">（无备注）</span>}
        </div>
        <hr className="border-slate-200" />
        <p className="text-xs text-slate-400">⚙ ZSpace Memo 数据（请勿手动修改）</p>
        <p className="break-all rounded-lg bg-slate-200/70 p-2 font-mono text-[11px] text-slate-600">
          ZSM1:
          {JSON.stringify({
            v: 1,
            rev: task.rev,
            status: task.status,
            priority: task.priority,
            list: task.list ?? undefined,
            schedule: task.schedule,
            reminders: task.reminders,
            repeat: task.repeat ?? undefined,
          })}
        </p>
      </div>
    </div>
  );
}
