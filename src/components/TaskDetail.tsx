import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Calendar,
  Check,
  ChevronRight,
  Copy,
  FileCode2,
  Flag,
  Folder,
  Hash,
  ListChecks,
  MoreHorizontal,
  Pin,
  Plus,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { OccurrenceView, Priority, Reminder, RepeatRule, Schedule, Task, UpdateTaskInput } from "../types";
import {
  dateLabel,
  describeRepeatZh,
  dueLabel,
  effectiveDue,
  isTaskOverdue,
  PRIORITY_META,
  reminderLabel,
  todayStr,
} from "../utils/date";
import { formatTime, usePrefs } from "../utils/prefs";
import { DatePickerModal } from "./DatePickerModal";
import { ReminderModal } from "./ReminderModal";
import { RepeatModal } from "./RepeatModal";

interface Props {
  task: Task | null;
  lists?: string[];
  defaultAllDayTime?: string;
  onUpdate: (id: number, patch: UpdateTaskInput) => Promise<void>;
  onToggle: (task: Task) => Promise<void>;
  onSkip: (task: Task, key?: string) => Promise<void>;
  onReopenOccurrence: (task: Task, key: string) => Promise<void>;
  onOverrideOccurrence?: (task: Task, occurrenceKey: string, nextSchedule: Schedule) => Promise<void>;
  onClearOccurrenceOverride?: (task: Task, occurrenceKey: string) => Promise<void>;
  onEndSeries: (task: Task) => Promise<void>;
  onDelete: (task: Task) => Promise<void>;
  onReloadTask: (id: number) => Promise<void>;
  onClose?: () => void;
  conflictMessage?: string | null;
  onClearConflict?: () => void;
}

const PRI_OPTIONS: Priority[] = ["urgent", "high", "low", "normal"];

export function TaskDetail({
  task,
  lists = [],
  defaultAllDayTime = "09:00",
  onUpdate,
  onToggle,
  onSkip,
  onReopenOccurrence,
  onOverrideOccurrence,
  onClearOccurrenceOverride,
  onEndSeries,
  onDelete,
  onReloadTask,
  onClose,
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
  const [editingOcc, setEditingOcc] = useState<OccurrenceView | null>(null);
  const [pendingPatch, setPendingPatch] = useState<UpdateTaskInput | null>(null);
  const [topPop, setTopPop] = useState<"pri" | "more" | null>(null);
  const topPopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!topPop) return;
    const onDown = (e: MouseEvent) => {
      if (topPopRef.current && !topPopRef.current.contains(e.target as Node)) setTopPop(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [topPop]);

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
    setTopPop(null);
    setEditingOcc(null);

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
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400">
        <span>选择一个任务查看详情</span>
        <span className="text-xs text-slate-300">快捷键：N 新建 · Ctrl+K 搜索 · ↑↓ 切换</span>
      </div>
    );
  }

  const done = task.status === "completed" || task.status === "ended";
  const due = effectiveDue(task);
  const overdue = isTaskOverdue(task);
  const isToday = due?.date === todayStr();
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
      `确定删除「${task.title}」吗？\n\n这会删除对应的极空间原生笔记（先进入「最近删除」，再次删除将永久删除）。\n如果是完成任务，请点击左侧勾选框。`
    );
    if (ok) {
      await onDelete(task);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Dida365-style Top Action Header */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        {tab === "note" ? (
          <button
            type="button"
            onClick={() => setTab("detail")}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回任务详情
          </button>
        ) : (
          <>
            <button
              type="button"
              title={task.repeat ? "完成本次" : done ? "重新打开" : "标记完成"}
              onClick={() => void onToggle(task)}
              style={done ? undefined : { borderColor: pri.hex }}
              className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition ${
                done ? "border-slate-300 bg-slate-300 text-white" : "hover:bg-slate-100"
              }`}
            >
              {done && <Check className="h-3 w-3 stroke-[3]" />}
            </button>

            <span className="h-4 w-px bg-slate-200" />

            <button
              type="button"
              onClick={() => setModal("date")}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition ${
                overdue
                  ? "bg-red-50 font-medium text-red-600 hover:bg-red-100"
                  : isToday
                  ? "bg-blue-50 font-medium text-blue-600 hover:bg-blue-100"
                  : due
                  ? "text-slate-700 hover:bg-slate-100"
                  : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              }`}
            >
              <Calendar className="h-3.5 w-3.5" />
              <span>
                {due
                  ? `${dueLabel(due.date)}${!due.all_day && due.time ? ` ${formatTime(due.time, prefs.timeFormat)}` : ""}`
                  : "设置日期"}
              </span>
            </button>
          </>
        )}

        <div ref={topPopRef} className="relative ml-auto flex items-center gap-1">
          {saving !== "idle" && (
            <span className="mr-1 text-[11px] text-slate-400">
              {saving === "saving" ? "保存中…" : "已同步 ✓"}
            </span>
          )}

          <button
            type="button"
            title={`优先级：${pri.label}`}
            onClick={() => setTopPop((v) => (v === "pri" ? null : "pri"))}
            className="rounded-lg p-1.5 hover:bg-slate-100"
          >
            <Flag className="h-4 w-4" style={{ color: pri.hex }} />
          </button>

          <button
            type="button"
            title={task.pinned ? "取消置顶" : "置顶"}
            onClick={() => void savePatch({ pinned: !task.pinned })}
            className={`rounded-lg p-1.5 ${
              task.pinned ? "bg-blue-50 text-blue-600" : "text-slate-400 hover:bg-slate-100"
            }`}
          >
            <Pin className="h-4 w-4" />
          </button>

          <button
            type="button"
            title="更多"
            onClick={() => setTopPop((v) => (v === "more" ? null : "more"))}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>

          {onClose && (
            <button
              type="button"
              title="收起详情 (Esc)"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}

          {topPop === "pri" && (
            <div className="absolute right-8 top-full z-40 mt-1 w-32 rounded-xl border border-slate-200 bg-white p-1 text-xs shadow-lg animate-pop-in">
              {PRI_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setTopPop(null);
                    void savePatch({ priority: p });
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-slate-700 hover:bg-slate-100"
                >
                  <Flag className="h-3.5 w-3.5" style={{ color: PRIORITY_META[p].hex }} />
                  <span className="flex-1">{PRIORITY_META[p].label}</span>
                  {task.priority === p && <Check className="h-3.5 w-3.5 text-blue-600" />}
                </button>
              ))}
            </div>
          )}

          {topPop === "more" && (
            <div className="absolute right-0 top-full z-40 mt-1 w-44 rounded-xl border border-slate-200 bg-white p-1 text-xs shadow-lg animate-pop-in">
              <button
                type="button"
                onClick={() => {
                  setTab((t) => (t === "note" ? "detail" : "note"));
                  setTopPop(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-slate-700 hover:bg-slate-100"
              >
                <FileCode2 className="h-3.5 w-3.5 text-slate-400" />
                <span>{tab === "note" ? "返回任务详情" : "极空间笔记预览"}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(task.title);
                  setTopPop(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-slate-700 hover:bg-slate-100"
              >
                <Copy className="h-3.5 w-3.5 text-slate-400" />
                <span>复制任务标题</span>
              </button>
              <div className="my-1 border-t border-slate-100" />
              <button
                type="button"
                onClick={() => {
                  setTopPop(null);
                  void handleDelete();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-red-600 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>删除任务</span>
              </button>
            </div>
          )}
        </div>
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
        <div className="flex-1 overflow-y-auto px-4 pb-5 pt-3.5 space-y-4">
          {/* Borderless large title */}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title.trim() && title.trim() !== task.title) {
                void savePatch({ title: title.trim() });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="准备做什么？"
            className={`w-full bg-transparent text-[17px] font-semibold leading-snug outline-none ${
              done ? "line-through text-slate-400" : "text-slate-900"
            }`}
          />

          {/* Description / Dida365-style lightweight Checklist */}
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs text-slate-400">
              <span>{checklistMode ? "检查清单（保存在笔记正文中）" : "描述 / 备注"}</span>
              {task.rich_body_protected ? (
                <span className="text-amber-600">包含官方富文本，已保护只读</span>
              ) : (
                <button
                  type="button"
                  onClick={() => setChecklistMode((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition ${
                    checklistMode
                      ? "bg-blue-50 text-blue-600 font-medium"
                      : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  }`}
                >
                  <ListChecks className="h-3.5 w-3.5" />
                  {checklistMode ? "切回文本" : "检查清单"}
                </button>
              )}
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
                rows={4}
                readOnly={task.rich_body_protected}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (!task.rich_body_protected && description !== task.description) {
                    void savePatch({ description });
                  }
                }}
                placeholder="添加描述、链接或补充信息…"
                className="w-full resize-y rounded-lg border border-transparent bg-slate-50/60 p-2.5 text-sm outline-none transition focus:border-blue-300 focus:bg-white read-only:bg-slate-50"
              />
            )}
          </div>

          {/* Structured property rows */}
          <div className="divide-y divide-slate-100 border-y border-slate-100 text-sm">
            <button
              type="button"
              onClick={() => setModal("reminder")}
              className="flex w-full items-center gap-3 py-2 text-left hover:bg-slate-50 -mx-2 px-2 rounded-lg"
            >
              <Bell className="h-4 w-4 text-slate-400" />
              <span className="w-12 text-xs text-slate-500">提醒</span>
              <div className="flex flex-1 flex-wrap gap-1">
                {task.reminders.length === 0 ? (
                  <span className="text-xs text-slate-400">不提醒</span>
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
              className="flex w-full items-center gap-3 py-2 text-left hover:bg-slate-50 -mx-2 px-2 rounded-lg"
            >
              <Repeat className="h-4 w-4 text-slate-400" />
              <span className="w-12 text-xs text-slate-500">重复</span>
              <span className={`flex-1 text-xs ${task.repeat ? "text-slate-800" : "text-slate-400"}`}>
                {describeRepeatZh(task.repeat)}
              </span>
              <ChevronRight className="h-4 w-4 text-slate-300" />
            </button>

            <div className="flex items-center gap-3 py-2">
              <Folder className="h-4 w-4 text-slate-400" />
              <span className="w-12 text-xs text-slate-500">清单</span>
              <input
                list="zsm-lists-datalist"
                value={list}
                onChange={(e) => setList(e.target.value)}
                onBlur={() => {
                  const trimmed = list.trim() || null;
                  if (trimmed !== (task.list ?? null)) {
                    void savePatch({ list: trimmed });
                  }
                }}
                placeholder="未分类（如：工作、个人）"
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-slate-400"
              />
              {lists.length > 0 && (
                <datalist id="zsm-lists-datalist">
                  {lists.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              )}
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
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-slate-400"
              />
            </div>
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
                    pending: ["●", "text-blue-600", "待办"],
                    future: ["○", "text-slate-400", "未来"],
                  }[occ.state];
                  const occDate = occ.schedule.due?.date ?? occ.key;
                  const occTime =
                    !occ.schedule.all_day && occ.schedule.due?.time
                      ? ` ${formatTime(occ.schedule.due.time, prefs.timeFormat)}`
                      : "";
                  const canEditOcc =
                    occ.state === "pending" || occ.state === "future" || occ.state === "missed";
                  return (
                    <div key={occ.key} className="flex items-center gap-2 py-1.5 text-xs">
                      <span className={`w-3.5 shrink-0 text-center ${badge[1]}`}>{badge[0]}</span>
                      <span className="min-w-0 truncate text-slate-700">
                        {dateLabel(occDate)}
                        {occTime}
                      </span>
                      <span className={`shrink-0 ${badge[1]}`}>{badge[2]}</span>
                      {occ.overridden && (
                        <span
                          title={`原计划：${occ.key}`}
                          className="shrink-0 rounded bg-amber-100/80 px-1 py-0.5 text-[10px] text-amber-700"
                        >
                          已改期
                        </span>
                      )}
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        {occ.state === "pending" && (
                          <>
                            <button
                              type="button"
                              onClick={() => void onToggle(task)}
                              className="text-blue-600 hover:underline"
                            >
                              完成
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
                        {canEditOcc && onOverrideOccurrence && (
                          <button
                            type="button"
                            onClick={() => setEditingOcc(occ)}
                            className="text-slate-600 hover:text-blue-600 hover:underline"
                          >
                            改期
                          </button>
                        )}
                        {canEditOcc && occ.overridden && onClearOccurrenceOverride && (
                          <button
                            type="button"
                            onClick={() => void onClearOccurrenceOverride(task, occ.key)}
                            className="text-amber-600 hover:underline"
                          >
                            恢复
                          </button>
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

          {/* Footer metadata */}
          <div className="pt-1 text-[11px] text-slate-400">
            极空间笔记 #{task.id}
            {task.created_at ? ` · 创建于 ${task.created_at.slice(0, 16).replace("T", " ")}` : ""}
            {task.updated_at ? ` · 同步于 ${task.updated_at.slice(0, 16).replace("T", " ")}` : ""}
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

      {editingOcc && onOverrideOccurrence && (
        <DatePickerModal
          schedule={editingOcc.schedule}
          singleOccurrence
          titleText={`单独调整「${dateLabel(editingOcc.key)}」这一期（不影响系列后续）`}
          onClose={() => setEditingOcc(null)}
          onSave={(next: Schedule) => {
            const key = editingOcc.key;
            setEditingOcc(null);
            void onOverrideOccurrence(task, key, next);
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
