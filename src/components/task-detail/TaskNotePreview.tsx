import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo, useState } from "react";
import type { Task } from "../../types";
import {
  describeRepeatZh,
  type effectiveDue,
  PRIORITY_META,
  reminderLabel,
} from "../../utils/date";
import { parseMarkdownBlocks, type InlineToken } from "../../utils/markdown";
import { formatTime, type UiPrefs } from "../../utils/prefs";

interface Props {
  task: Task;
  due: ReturnType<typeof effectiveDue>;
  done: boolean;
  prefs: UiPrefs;
}

function renderInlines(tokens: InlineToken[]) {
  return tokens.map((tok, idx) => {
    switch (tok.type) {
      case "bold":
        return (
          <strong key={idx} className="font-semibold text-slate-900">
            {tok.text}
          </strong>
        );
      case "italic":
        return (
          <em key={idx} className="italic text-slate-700">
            {tok.text}
          </em>
        );
      case "code":
        return (
          <code
            key={idx}
            className="rounded bg-slate-200/80 px-1 py-0.5 font-mono text-[11px] text-slate-800"
          >
            {tok.text}
          </code>
        );
      case "link":
        return (
          <button
            key={idx}
            type="button"
            onClick={() => void openUrl(tok.href)}
            title={tok.href}
            className="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
          >
            {tok.label}
          </button>
        );
      default:
        return <span key={idx}>{tok.text}</span>;
    }
  });
}

export function TaskNotePreview({ task, due, done, prefs }: Props) {
  const pri = PRIORITY_META[task.priority];
  const [mode, setMode] = useState<"markdown" | "raw">("markdown");
  const mdBlocks = useMemo(
    () => (task.description ? parseMarkdownBlocks(task.description) : []),
    [task.description]
  );

  return (
    <div className="flex-1 overscroll-contain overflow-y-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {mode === "markdown"
            ? "备注 Markdown 只读预览（支持标题、粗体、代码块、清单与安全外链）"
            : "以下是保存在极空间原生记事本（location=\"2\"）中的摘要与数据块："}
        </p>
        <div className="inline-flex shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setMode("markdown")}
            className={`rounded-md px-2 py-0.5 transition ${
              mode === "markdown"
                ? "bg-white font-medium text-slate-900 shadow-xs"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            Markdown
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={`rounded-md px-2 py-0.5 transition ${
              mode === "raw"
                ? "bg-white font-medium text-slate-900 shadow-xs"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            ZSM1 原文
          </button>
        </div>
      </div>

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
        {mode === "raw" ? (
          <div className="whitespace-pre-wrap text-slate-800">
            {task.description || <span className="text-slate-400">（无备注）</span>}
          </div>
        ) : mdBlocks.length === 0 ? (
          <div className="text-slate-400">（无备注）</div>
        ) : (
          <div className="space-y-1.5 text-slate-800 leading-relaxed">
            {mdBlocks.map((b, idx) => {
              if (b.type === "heading") {
                const cls =
                  b.level === 1
                    ? "text-base font-bold text-slate-900 pt-1"
                    : b.level === 2
                    ? "text-sm font-bold text-slate-900 pt-0.5"
                    : "text-xs font-semibold uppercase tracking-wide text-slate-700";
                return (
                  <div key={idx} className={cls}>
                    {renderInlines(b.inlines)}
                  </div>
                );
              }
              if (b.type === "code") {
                return (
                  <pre
                    key={idx}
                    className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-900 p-2.5 font-mono text-[11px] text-slate-100"
                  >
                    <code>{b.content}</code>
                  </pre>
                );
              }
              if (b.type === "checklist") {
                return (
                  <div key={idx} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 select-none">{b.checked ? "☑" : "☐"}</span>
                    <span className={b.checked ? "line-through text-slate-400" : ""}>
                      {renderInlines(b.inlines)}
                    </span>
                  </div>
                );
              }
              if (b.type === "bullet") {
                return (
                  <div key={idx} className="flex items-start gap-2 pl-1 text-sm">
                    <span className="select-none text-slate-400">•</span>
                    <span className="min-w-0 flex-1">{renderInlines(b.inlines)}</span>
                  </div>
                );
              }
              return <p key={idx}>{renderInlines(b.inlines)}</p>;
            })}
          </div>
        )}
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
