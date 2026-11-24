import {
  AlertTriangle,
  Bell,
  Calendar,
  Check,
  ChevronRight,
  Folder,
  Hash,
  ListChecks,
  Pin,
  Plus,
  Repeat,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { OccurrenceView, Priority, Reminder, RepeatRule, Schedule, Task, UpdateTaskInput } from "../types";
import {
  dateLabel,
  describeRepeatZh,
  effectiveDue,
  isTaskOverdue,
  PRIORITY_META,
  reminderLabel,
} from "../utils/date";
import { formatTime, usePrefs } from "../utils/prefs";
import { DatePickerModal } from "./DatePickerModal";
import { ReminderModal } from "./ReminderModal";
import { RepeatModal } from "./RepeatModal";

interface Props {
  task: Task | null;
  defaultAllDayTime?: string;
  onUpdate: (id: number, patch: UpdateTaskInput) => Promise<void>;
  onToggle: (task: Task) => Promise<void>;
  onSkip: (task: Task, key?: string) => Promise<void>;
  onReopenOccurrence: (task: Task, key: string) => Promise<void>;
  onEndSeries: (task: Task) => Promise<void>;
  onDelete: (task: Task) => Promise<void>;
  onReloadTask: (id: number) => Promise<void>;
  conflictMessage?: string | null;
  onClearConflict?: () => void;
}

export function TaskDetail({
  task,
  defaultAllDayTime = "09:00",
  onUpdate,
  onToggle,
  onSkip,
  onReopenOccurrence,
  onEndSeries,
  onDelete,
  onReloadTask,
  conflictMessage,
  onClearConflict,
}: Props) {
  const prefs = usePrefs();
  const [tab, setTab] = useState<"detail" | "note">("detail");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [list, setList] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [checklistMode, setChecklistMode] = useState(false);
  const [newCheckItem, setNewCheckItem] = useState("");
  const [timeline, setTimeline] = useState<OccurrenceView[]>([]);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [modal, setModal] = useState<"date" | "reminder" | "repeat" | null>(null);
  const [pendingPatch, setPendingPatch] = useState<UpdateTaskInput | null>(null);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description);
    setList(task.list ?? "");
    setLabelsText(task.labels.join(", "));
    setChecklistMode(
      task.description
        .split("\n")
        .some((l) => /^\s*-\s*\[[ xX]\]\s+/.test(l))
    );
    setTab("detail");
    setPendingPatch(null);

    if (task.repeat) {
      api
        .getOccurrenceTimeline(task.id, 3)
        .then(setTimeline)
        .catch(() => setTimeline([]));
    } else {
      setTimeline([]);
    }
  }, [task?.id, task?.etag]);

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        选择一个任务查看详情
      </div>
    );
  }

  const done = task.status === "completed" || task.status === "ended";
  const due = effectiveDue(task);
  const overdue = isTaskOverdue(task);
  const pri = PRIORITY_META[task.priority];

  async function savePatch(patch: UpdateTaskInput) {
    if (!task) return;
    setSaving("saving");
    setPendingPatch(patch);
    try {
      await onUpdate(task.id, { ...patch, etag: task.etag });
      setPendingPatch(null);
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 1500);
    } catch {
      setSaving("idle");
    }
  }

  async function handleForceOverwrite() {
    if (!task || !pendingPatch) return;
    await onUpdate(task.id, { ...pendingPatch, force: true });
    setPendingPatch(null);
    onClearConflict?.();
  }

  async function handleDelete() {
    if (!task) return;
    const ok = window.confirm(
      `确定删除「${task.title}」吗？\n\n这会删除对应的极空间原生笔记（先进入「最近删除」，再次删除将永久删除）。\n如果是完成任务，请点击左侧圆圈勾选。`
    );
    if (ok) {
      await onDelete(task);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
        <div className="flex gap-1">
          {(
            [
              ["detail", "任务详情"],
              ["note", "极空间笔记预览"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`rounded-full px-2.5 py-0.5 text-xs transition ${
                tab === k
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400">
          {saving === "saving" ? "保存中…" : saving === "saved" ? "已同步到 NAS ✓" : ""}
        </span>
      </div>

      {conflictMessage && (
        <div className="mx-4 mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>{conflictMessage}</span>
          </div>
          <div className="flex gap-2">
            {pendingPatch && (
              <button
                type="button"
                onClick={() => void handleForceOverwrite()}
                className="rounded-lg bg-amber-600 px-2.5 py-1 text-white hover:bg-amber-700"
              >
                用我的修改覆盖
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onClearConflict?.();
                void onReloadTask(task.id);
              }}
              className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-amber-800 hover:bg-amber-100"
            >
              放弃修改并刷新
            </button>
          </div>
        </div>
      )}

      {tab === "note" ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-xs text-slate-500">
            以下是该任务保存在极空间原生记事本（<code>location="2"</code>）中的可读摘要与末尾数据块结构：
          </p>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm space-y-2">
            <h1 className="text-lg font-bold">{task.title}</h1>
            {due && (
              <p className="text-slate-700">
                📅 截止 {due.date} {!due.all_day && due.time ? formatTime(due.time, prefs.timeFormat) : "（全天）"}
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
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Header: checkbox + editable title + priority + pin */}
          <div className="flex items-start gap-2.5">
            <button
              type="button"
              onClick={() => void onToggle(task)}
              style={done ? undefined : { borderColor: pri.hex }}
              className={`mt-1 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition ${
                done
                  ? "border-slate-300 bg-slate-300 text-white"
                  : "hover:bg-slate-100"
              }`}
            >
              {done && <Check className="h-3 w-3 stroke-[3]" />}
            </button>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (title.trim() && title.trim() !== task.title) {
                  void savePatch({ title: title.trim() });
                }
              }}
              className={`min-w-0 flex-1 bg-transparent text-base font-semibold outline-none ${
                done ? "line-through text-slate-400" : "text-slate-900"
              }`}
            />
            <button
              type="button"
              title={task.pinned ? "取消置顶" : "置顶"}
              onClick={() => void savePatch({ pinned: !task.pinned })}
              className={`rounded-lg p-1.5 ${
                task.pinned
                  ? "bg-blue-50 text-blue-600"
                  : "text-slate-400 hover:bg-slate-100"
              }`}
            >
              <Pin className="h-4 w-4" />
            </button>
            <select
              value={task.priority}
              onChange={(e) => void savePatch({ priority: e.target.value as Priority })}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
            >
              <option value="low">↓ 低</option>
              <option value="normal">普通</option>
              <option value="high">! 高</option>
              <option value="urgent">‼ 紧急</option>
            </select>
          </div>

          {/* Structured property rows */}
          <div className="divide-y divide-slate-100 border-y border-slate-100 text-sm">
            <button
              type="button"
              onClick={() => setModal("date")}
              className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-slate-50 -mx-2 px-2 rounded-lg"
            >
              <Calendar className="h-4 w-4 text-slate-400" />
              <span className="w-12 text-xs text-slate-500">截止</span>
              <span
                className={`flex-1 text-sm ${
                  overdue ? "font-medium text-red-600" : due ? "text-slate-800" : "text-slate-400"
                }`}
              >
                {due
                  ? `${dateLabel(due.date)}${!due.all_day && due.time ? ` ${formatTime(due.time, prefs.timeFormat)}` : " · 全天"}`
                  : "设置截止日期与时间"}
              </span>
              <ChevronRight className="h-4 w-4 text-slate-300" />
            </button>

            <button
              type="button"
              onClick={() => setModal("reminder")}
              className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-slate-50 -mx-2 px-2 rounded-lg"
            >
              <Bell className="h-4 w-4 text-slate-400" />
              <span className="w-12 text-xs text-slate-500">提醒</span>
              <div className="flex flex-1 flex-wrap gap-1">
                {task.reminders.length === 0 ? (
                  <span className="text-sm text-slate-400">不提醒</span>
                ) : (
                  task.reminders.map((r) => (
                    <span
                      key={r.id}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                    >
                      {reminderLabel(r)}
                    </span>
                  ))
                )}
              </div>
              <ChevronRight className="h-4 w-4 text-slate-300" />
            </button>

            <button
              type="button"
              onClick={() => setModal("repeat")}
              className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-slate-50 -mx-2 px-2 rounded-lg"
            >
              <Repeat className="h-4 w-4 text-slate-400" />
              <span className="w-12 text-xs text-slate-500">重复</span>
              <span
                className={`flex-1 text-sm ${
                  task.repeat ? "text-slate-800" : "text-slate-400"
                }`}
              >
                {describeRepeatZh(task.repeat)}
              </span>
              <ChevronRight className="h-4 w-4 text-slate-300" />
            </button>

            <div className="flex items-center gap-3 py-2">
              <Folder className="h-4 w-4 text-slate-400" />
              <span className="w-12 text-xs text-slate-500">清单</span>
              <input
                value={list}
                onChange={(e) => setList(e.target.value)}
                onBlur={() => {
                  const trimmed = list.trim() || null;
                  if (trimmed !== (task.list ?? null)) {
                    void savePatch({ list: trimmed });
                  }
                }}
                placeholder="未分类（如：工作、个人）"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
            </div>

            <div className="flex items-center gap-3 py-2">
              <Hash className="h-4 w-4 text-slate-400" />
              <span className="w-12 text-xs text-slate-500">标签</span>
              <input
                value={labelsText}
                onChange={(e) => setLabelsText(e.target.value)}
                onBlur={() => {
                  const parsed = labelsText
                    .split(/[,，]/)
                    .map((x) => x.trim())
                    .filter(Boolean);
                  if (JSON.stringify(parsed) !== JSON.stringify(task.labels)) {
                    void savePatch({ labels: parsed });
                  }
                }}
                placeholder="逗号分隔（如：续费, eSIM）"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
            </div>
          </div>

          {/* Description / Dida365-style lightweight Checklist */}
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs text-slate-500">
              <span>{checklistMode ? "检查清单（子步骤，保存在笔记正文中）" : "备注（支持多行、链接、基础 Markdown）"}</span>
              <div className="flex items-center gap-2">
                {task.rich_body_protected ? (
                  <span className="text-amber-600">包含官方富文本，已保护只读</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setChecklistMode((v) => !v)}
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition ${
                      checklistMode
                        ? "bg-blue-50 text-blue-600 font-medium"
                        : "text-slate-500 hover:bg-slate-100"
                    }`}
                  >
                    <ListChecks className="h-3.5 w-3.5" />
                    {checklistMode ? "切回文本" : "检查清单"}
                  </button>
                )}
              </div>
            </div>

            {checklistMode && !task.rich_body_protected ? (
              <div className="rounded-xl border border-slate-200 p-2.5 space-y-1.5">
                {description
                  .split("\n")
                  .filter((l) => l.trim().length > 0)
                  .map((line, idx, allLines) => {
                    const checked = /^\s*-\s*\[[xX]\]\s+/.test(line);
                    const text = line.replace(/^\s*-\s*\[[ xX]\]\s+/, "").replace(/^\s*-\s+/, "");
                    return (
                      <div key={idx} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const nextLines = [...allLines];
                            nextLines[idx] = `${checked ? "- [ ]" : "- [x]"} ${text}`;
                            const nextDesc = nextLines.join("\n");
                            setDescription(nextDesc);
                            void savePatch({ description: nextDesc });
                          }}
                          className="h-3.5 w-3.5 accent-blue-600"
                        />
                        <span className={`flex-1 ${checked ? "line-through text-slate-400" : "text-slate-800"}`}>
                          {text}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const nextDesc = allLines.filter((_, i) => i !== idx).join("\n");
                            setDescription(nextDesc);
                            void savePatch({ description: nextDesc });
                          }}
                          className="text-xs text-slate-300 hover:text-red-500"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                <div className="flex items-center gap-1.5 pt-1">
                  <Plus className="h-3.5 w-3.5 text-slate-400" />
                  <input
                    value={newCheckItem}
                    onChange={(e) => setNewCheckItem(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newCheckItem.trim()) {
                        const existing = description
                          .split("\n")
                          .filter((l) => l.trim().length > 0);
                        existing.push(`- [ ] ${newCheckItem.trim()}`);
                        const nextDesc = existing.join("\n");
                        setDescription(nextDesc);
                        setNewCheckItem("");
                        void savePatch({ description: nextDesc });
                      }
                    }}
                    placeholder="添加检查项，回车保存"
                    className="flex-1 bg-transparent text-xs outline-none placeholder:text-slate-400"
                  />
                </div>
              </div>
            ) : (
              <textarea
                rows={5}
                readOnly={task.rich_body_protected}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (!task.rich_body_protected && description !== task.description) {
                    void savePatch({ description });
                  }
                }}
                placeholder="添加任务说明、链接或补充信息…"
                className="w-full rounded-xl border border-slate-200 p-2.5 text-sm outline-none focus:border-blue-400 read-only:bg-slate-50"
              />
            )}
          </div>

          {/* Repeating series occurrence timeline */}
          {task.repeat && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">
                  重复实例 · 原生笔记 #{task.id}
                </span>
                {task.status !== "ended" && (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm("确定终止整个重复系列？历史记录会保留，之后不再生成新实例。")) {
                        void onEndSeries(task);
                      }
                    }}
                    className="text-red-600 hover:underline"
                  >
                    终止系列
                  </button>
                )}
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-1.5 divide-y divide-slate-100">
                {timeline.map((occ) => {
                  const badge = {
                    completed: ["✓", "text-emerald-600", "已完成"],
                    skipped: ["↷", "text-slate-400", "已跳过"],
                    missed: ["✕", "text-red-500", "错过"],
                    pending: ["●", "text-blue-600", "待办（本次）"],
                    future: ["○", "text-slate-400", "未来"],
                  }[occ.state];
                  return (
                    <div
                      key={occ.key}
                      className="flex items-center gap-2 py-1.5 text-xs"
                    >
                      <span className={`w-4 text-center ${badge[1]}`}>{badge[0]}</span>
                      <span className="w-28 text-slate-700">{dateLabel(occ.key)}</span>
                      <span className={`w-20 ${badge[1]}`}>{badge[2]}</span>
                      <div className="flex-1 text-right space-x-2">
                        {occ.state === "pending" && (
                          <>
                            <button
                              type="button"
                              onClick={() => void onToggle(task)}
                              className="text-blue-600 hover:underline"
                            >
                              完成本次
                            </button>
                            <button
                              type="button"
                              onClick={() => void onSkip(task, occ.key)}
                              className="text-slate-500 hover:underline"
                            >
                              跳过
                            </button>
                          </>
                        )}
                        {(occ.state === "completed" || occ.state === "skipped") && (
                          <button
                            type="button"
                            onClick={() => void onReopenOccurrence(task, occ.key)}
                            className="text-blue-600 hover:underline"
                          >
                            撤销
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Footer metadata & delete */}
          <div className="border-t border-slate-100 pt-3 text-xs text-slate-400 space-y-1">
            <div>
              极空间笔记 #{task.id}
              {task.created_at ? ` · 创建于 ${task.created_at.slice(0, 16).replace("T", " ")}` : ""}
            </div>
            <div className="flex items-center justify-between pt-1">
              <span>
                {task.updated_at
                  ? `最后同步 ${task.updated_at.slice(0, 16).replace("T", " ")}`
                  : ""}
              </span>
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="inline-flex items-center gap-1 text-red-600 hover:underline"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除任务
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "date" && (
        <DatePickerModal
          schedule={task.schedule}
          onClose={() => setModal(null)}
          onSave={(next: Schedule) => {
            setModal(null);
            void savePatch({ schedule: next });
          }}
          onSaveAndOpenReminder={(next: Schedule) => {
            void savePatch({ schedule: next });
            setModal("reminder");
          }}
          onSaveAndOpenRepeat={(next: Schedule) => {
            void savePatch({ schedule: next });
            setModal("repeat");
          }}
        />
      )}

      {modal === "reminder" && (
        <ReminderModal
          schedule={task.schedule}
          reminders={task.reminders}
          defaultAllDayTime={defaultAllDayTime}
          onClose={() => setModal(null)}
          onSave={(next: Reminder[]) => {
            setModal(null);
            void savePatch({ reminders: next });
          }}
        />
      )}

      {modal === "repeat" && (
        <RepeatModal
          baseDate={due?.date ?? null}
          repeat={task.repeat ?? null}
          onClose={() => setModal(null)}
          onSave={(rule: RepeatRule | null) => {
            setModal(null);
            void savePatch({ repeat: rule });
          }}
        />
      )}
    </div>
  );
}
