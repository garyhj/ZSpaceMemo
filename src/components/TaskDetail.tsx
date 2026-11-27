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
  MoreHorizontal,
  Pin,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  OccurrenceView,
  Priority,
  Reminder,
  RepeatRule,
  Schedule,
  Task,
  TaskAttachment,
  UpdateTaskInput,
} from "../types";
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
import { AnchoredPopover } from "./AnchoredPopover";
import { confirmAction } from "./ConfirmDialog";
import { TaskAttachmentsSection } from "./task-detail/TaskAttachmentsSection";
import { TaskChecklistEditor } from "./task-detail/TaskChecklistEditor";
import { TaskNotePreview } from "./task-detail/TaskNotePreview";
import { TaskOccurrenceTimeline } from "./task-detail/TaskOccurrenceTimeline";

const DatePickerModal = lazy(() =>
  import("./DatePickerModal").then((m) => ({ default: m.DatePickerModal }))
);
const ReminderModal = lazy(() =>
  import("./ReminderModal").then((m) => ({ default: m.ReminderModal }))
);
const RepeatModal = lazy(() =>
  import("./RepeatModal").then((m) => ({ default: m.RepeatModal }))
);

interface Props {
  task: Task | null;
  lists?: string[];
  defaultAllDayTime?: string;
  onUpdate: (id: number, patch: UpdateTaskInput) => Promise<Task | void>;
  onToggle: (task: Task) => Promise<void>;
  onSkip: (task: Task, key?: string) => Promise<void>;
  onReopenOccurrence: (task: Task, key: string) => Promise<void>;
  onOverrideOccurrence?: (task: Task, occurrenceKey: string, nextSchedule: Schedule) => Promise<void>;
  onClearOccurrenceOverride?: (task: Task, occurrenceKey: string) => Promise<void>;
  onUploadAttachment?: (task: Task, localPath: string) => Promise<void>;
  onDownloadAttachment?: (task: Task, att: TaskAttachment, localDest: string) => Promise<void>;
  onRemoveAttachment?: (task: Task, fileId: string) => Promise<void>;
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
  onUploadAttachment,
  onDownloadAttachment,
  onRemoveAttachment,
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
  const [attBusy, setAttBusy] = useState(false);
  const [modal, setModal] = useState<"date" | "reminder" | "repeat" | null>(null);
  const [editingOcc, setEditingOcc] = useState<OccurrenceView | null>(null);
  const [pendingPatch, setPendingPatch] = useState<UpdateTaskInput | null>(null);
  const [topPop, setTopPop] = useState<"pri" | "more" | null>(null);
  const priBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const closedPopRef = useRef<{ key: "pri" | "more" | null; ts: number }>({ key: null, ts: 0 });

  function toggleTopPop(next: "pri" | "more") {
    setTopPop((prev) => {
      if (prev === next) return null;
      if (
        prev === null &&
        closedPopRef.current.key === next &&
        Date.now() - closedPopRef.current.ts < 200
      ) {
        return null;
      }
      return next;
    });
  }

  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const taskIdRef = useRef<number | null>(task?.id ?? null);
  const etagByTaskRef = useRef<Map<number, string | null | undefined>>(new Map());
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const savedTimerRef = useRef<number | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const deletedTaskIdRef = useRef<number | null>(null);
  const dirtyFieldsRef = useRef({
    title: false,
    description: false,
    list: false,
    labels: false,
  });
  const draftRef = useRef({
    taskId: 0,
    title: "",
    description: "",
    list: "",
    labelsText: "",
    baseTitle: "",
    baseDescription: "",
    baseList: null as string | null,
    baseLabels: [] as string[],
    richProtected: false,
  });

  function clearDebounceTimer() {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }

  function enqueuePatch(
    targetId: number,
    patch: UpdateTaskInput,
    sentSnapshot?: {
      title?: string;
      description?: string;
      list?: string | null;
      labels?: string[];
    }
  ): Promise<void> {
    const run = async () => {
      if (taskIdRef.current === targetId) {
        setSaving("saving");
        setPendingPatch(patch);
      }
      const etag = etagByTaskRef.current.get(targetId);
      try {
        const updated = await onUpdateRef.current(targetId, {
          ...patch,
          ...(patch.force ? {} : etag ? { etag } : {}),
        });
        if (updated) {
          etagByTaskRef.current.set(targetId, updated.etag);
          if (draftRef.current.taskId === targetId) {
            draftRef.current.baseTitle = updated.title;
            draftRef.current.baseDescription = updated.description;
            draftRef.current.baseList = updated.list ?? null;
            draftRef.current.baseLabels = updated.labels;
            draftRef.current.richProtected = updated.rich_body_protected;
          }
        }
        if (taskIdRef.current === targetId && sentSnapshot) {
          if (sentSnapshot.title !== undefined && draftRef.current.title.trim() === sentSnapshot.title) {
            dirtyFieldsRef.current.title = false;
          }
          if (
            sentSnapshot.description !== undefined &&
            draftRef.current.description === sentSnapshot.description
          ) {
            dirtyFieldsRef.current.description = false;
          }
          if (
            sentSnapshot.list !== undefined &&
            (draftRef.current.list.trim() || null) === sentSnapshot.list
          ) {
            dirtyFieldsRef.current.list = false;
          }
          if (sentSnapshot.labels !== undefined) {
            const currentParsed = draftRef.current.labelsText
              .split(/[,，]/)
              .map((x) => x.trim())
              .filter(Boolean);
            if (JSON.stringify(currentParsed) === JSON.stringify(sentSnapshot.labels)) {
              dirtyFieldsRef.current.labels = false;
            }
          }
        }
        if (taskIdRef.current === targetId) {
          setPendingPatch(null);
          setSaving("saved");
          if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
          savedTimerRef.current = window.setTimeout(() => {
            setSaving("idle");
            savedTimerRef.current = null;
          }, 1500);
        }
      } catch {
        if (taskIdRef.current === targetId) {
          setSaving("idle");
        }
      }
    };
    const next = saveQueueRef.current.then(run, run);
    saveQueueRef.current = next;
    return next;
  }

  function flushDraftSnapshot(targetId = draftRef.current.taskId) {
    clearDebounceTimer();
    const d = draftRef.current;
    const dirty = dirtyFieldsRef.current;
    if (!targetId || d.taskId !== targetId || deletedTaskIdRef.current === targetId) {
      return;
    }
    const patch: UpdateTaskInput = {};
    const sentSnapshot: {
      title?: string;
      description?: string;
      list?: string | null;
      labels?: string[];
    } = {};

    if (dirty.title) {
      const nextTitle = d.title.trim();
      if (nextTitle && nextTitle !== d.baseTitle) {
        patch.title = nextTitle;
        sentSnapshot.title = nextTitle;
      } else if (nextTitle === d.baseTitle) {
        dirty.title = false;
      }
    }
    if (dirty.description) {
      if (!d.richProtected && d.description !== d.baseDescription) {
        patch.description = d.description;
        sentSnapshot.description = d.description;
      } else {
        dirty.description = false;
      }
    }
    if (dirty.list) {
      const nextList = d.list.trim() || null;
      if (nextList !== (d.baseList ?? null)) {
        patch.list = nextList;
        sentSnapshot.list = nextList;
      } else {
        dirty.list = false;
      }
    }
    if (dirty.labels) {
      const parsed = d.labelsText
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (JSON.stringify(parsed) !== JSON.stringify(d.baseLabels)) {
        patch.labels = parsed;
        sentSnapshot.labels = parsed;
      } else {
        dirty.labels = false;
      }
    }

    if (Object.keys(patch).length > 0) {
      void enqueuePatch(targetId, patch, sentSnapshot);
    }
  }

  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => flushDraftSnapshot();

  function scheduleDraftFlush() {
    clearDebounceTimer();
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      flushRef.current();
    }, 600);
  }

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
      clearDebounceTimer();
      flushRef.current();
    };
  }, []);

  useEffect(() => {
    const prevId = taskIdRef.current;
    const nextId = task?.id ?? null;

    if (prevId && prevId !== nextId) {
      flushRef.current();
    }

    taskIdRef.current = nextId;
    if (!task) {
      dirtyFieldsRef.current = { title: false, description: false, list: false, labels: false };
      draftRef.current.taskId = 0;
      return;
    }

    deletedTaskIdRef.current = null;
    etagByTaskRef.current.set(task.id, task.etag);
    const switchedTask = prevId !== task.id;
    const dirty = dirtyFieldsRef.current;

    if (switchedTask) {
      dirtyFieldsRef.current = { title: false, description: false, list: false, labels: false };
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
      setSaving("idle");
      setTopPop(null);
      setEditingOcc(null);
      draftRef.current = {
        taskId: task.id,
        title: task.title,
        description: task.description,
        list: task.list ?? "",
        labelsText: task.labels.join(", "),
        baseTitle: task.title,
        baseDescription: task.description,
        baseList: task.list ?? null,
        baseLabels: task.labels,
        richProtected: task.rich_body_protected,
      };
    } else {
      if (!dirty.title) {
        setTitle(task.title);
        draftRef.current.title = task.title;
      }
      if (!dirty.description) {
        setDescription(task.description);
        draftRef.current.description = task.description;
        setChecklistMode(
          task.description
            .split("\n")
            .some((l) => /^\s*-\s*\[[ xX]\]\s+/.test(l))
        );
      }
      if (!dirty.list) {
        setList(task.list ?? "");
        draftRef.current.list = task.list ?? "";
      }
      if (!dirty.labels) {
        const nextLabels = task.labels.join(", ");
        setLabelsText(nextLabels);
        draftRef.current.labelsText = nextLabels;
      }
      draftRef.current.baseTitle = task.title;
      draftRef.current.baseDescription = task.description;
      draftRef.current.baseList = task.list ?? null;
      draftRef.current.baseLabels = task.labels;
      draftRef.current.richProtected = task.rich_body_protected;
    }

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

  function savePatch(patch: UpdateTaskInput) {
    if (!task) return Promise.resolve();
    const sentSnapshot =
      patch.description !== undefined ? { description: patch.description } : undefined;
    return enqueuePatch(task.id, patch, sentSnapshot);
  }

  async function handleForceOverwrite() {
    if (!task || !pendingPatch) return;
    setSaving("saving");
    try {
      const updated = await onUpdateRef.current(task.id, { ...pendingPatch, force: true });
      if (updated) etagByTaskRef.current.set(task.id, updated.etag);
      onClearConflict?.();
      setPendingPatch(null);
      setSaving("saved");
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => {
        setSaving("idle");
        savedTimerRef.current = null;
      }, 1500);
    } catch {
      setSaving("idle");
    }
  }

  async function handleDelete() {
    if (!task) return;
    const attHint =
      task.attachments && task.attachments.length > 0
        ? "\n受极空间 CLI 接口限制，任务中关联的 NAS 附件不会同步物理删除。"
        : "";
    const ok = await confirmAction({
      title: "删除任务",
      message: `确定删除「${task.title}」吗？\n\n这会删除对应的极空间原生笔记（先进入「最近删除」，再次删除将永久删除）。\n如果是完成任务，请点击左侧勾选框。${attHint}`,
      confirmText: "删除",
      danger: true,
    });
    if (ok) {
      deletedTaskIdRef.current = task.id;
      clearDebounceTimer();
      dirtyFieldsRef.current = { title: false, description: false, list: false, labels: false };
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
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回编辑
          </button>
        ) : (
          <>
            <button
              type="button"
              title={task.repeat ? "完成本次" : done ? "重新打开" : "标记完成"}
              onClick={() => void onToggle(task)}
              style={done ? undefined : { borderColor: pri.hex }}
              className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition ${
                done ? "border-slate-300 bg-slate-300 text-white" : "hover:bg-slate-50"
              }`}
            >
              {done && <Check className="h-3 w-3 stroke-[3]" />}
            </button>

            <button
              type="button"
              onClick={() => setModal("date")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition hover:bg-slate-100 ${
                overdue
                  ? "text-red-500 font-medium"
                  : isToday
                  ? "text-blue-600 font-medium"
                  : due
                  ? "text-slate-700"
                  : "text-slate-400"
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

        <div className="relative ml-auto flex items-center gap-1">
          {saving !== "idle" && (
            <span className="mr-1 text-[11px] text-slate-400">
              {saving === "saving" ? "保存中…" : "已同步 ✓"}
            </span>
          )}

          <button
            ref={priBtnRef}
            type="button"
            title={`优先级：${pri.label}`}
            onClick={() => toggleTopPop("pri")}
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
            ref={moreBtnRef}
            type="button"
            title="更多"
            onClick={() => toggleTopPop("more")}
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

          <AnchoredPopover
            open={topPop === "pri"}
            onClose={() => {
              closedPopRef.current = { key: "pri", ts: Date.now() };
              setTopPop((cur) => (cur === "pri" ? null : cur));
            }}
            anchorEl={priBtnRef}
            align="right"
            side="bottom"
            gap={4}
            className="w-32 rounded-xl border border-slate-200 bg-white p-1 text-xs shadow-lg"
          >
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
          </AnchoredPopover>

          <AnchoredPopover
            open={topPop === "more"}
            onClose={() => {
              closedPopRef.current = { key: "more", ts: Date.now() };
              setTopPop((cur) => (cur === "more" ? null : cur));
            }}
            anchorEl={moreBtnRef}
            align="right"
            side="bottom"
            gap={4}
            className="w-44 rounded-xl border border-slate-200 bg-white p-1 text-xs shadow-lg"
          >
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
          </AnchoredPopover>
        </div>
      </div>

      {conflictMessage && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 space-y-1.5">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{conflictMessage}</span>
          </div>
          <div className="flex gap-2">
            {pendingPatch && (
              <button
                type="button"
                onClick={handleForceOverwrite}
                className="rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-700"
              >
                用我的修改覆盖云端
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                await onReloadTask(task.id);
                onClearConflict?.();
                setPendingPatch(null);
              }}
              className="rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100"
            >
              放弃修改并刷新
            </button>
          </div>
        </div>
      )}

      {tab === "note" ? (
        <TaskNotePreview task={task} due={due} done={done} prefs={prefs} />
      ) : (
        <div className="flex-1 overscroll-contain overflow-y-auto px-4 pb-5 pt-3.5 space-y-4">
          {/* Borderless large title */}
          <input
            value={title}
            onChange={(e) => {
              const val = e.target.value;
              setTitle(val);
              draftRef.current.title = val;
              dirtyFieldsRef.current.title = true;
              scheduleDraftFlush();
            }}
            onBlur={() => {
              if (!title.trim()) {
                setTitle(task.title);
                draftRef.current.title = task.title;
                dirtyFieldsRef.current.title = false;
                clearDebounceTimer();
                return;
              }
              flushDraftSnapshot(task.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="准备做什么？"
            className={`w-full bg-transparent text-[17px] font-semibold leading-snug outline-none ${
              done ? "line-through text-slate-400" : "text-slate-900"
            }`}
          />

          <TaskChecklistEditor
            checklistMode={checklistMode}
            onToggleChecklistMode={() => setChecklistMode((v) => !v)}
            richProtected={task.rich_body_protected}
            description={description}
            newCheckItem={newCheckItem}
            setNewCheckItem={setNewCheckItem}
            onDescriptionDraftChange={(val) => {
              setDescription(val);
              draftRef.current.description = val;
              dirtyFieldsRef.current.description = true;
              scheduleDraftFlush();
            }}
            onDescriptionCommit={(nextDesc) => {
              clearDebounceTimer();
              setDescription(nextDesc);
              draftRef.current.description = nextDesc;
              dirtyFieldsRef.current.description = true;
              void savePatch({ description: nextDesc });
            }}
            onBlurFlush={() => flushDraftSnapshot(task.id)}
          />

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
                onChange={(e) => {
                  const val = e.target.value;
                  setList(val);
                  draftRef.current.list = val;
                  dirtyFieldsRef.current.list = true;
                  scheduleDraftFlush();
                }}
                onBlur={() => {
                  flushDraftSnapshot(task.id);
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
                onChange={(e) => {
                  const val = e.target.value;
                  setLabelsText(val);
                  draftRef.current.labelsText = val;
                  dirtyFieldsRef.current.labels = true;
                  scheduleDraftFlush();
                }}
                onBlur={() => {
                  flushDraftSnapshot(task.id);
                }}
                placeholder="逗号分隔（如：续费, eSIM）"
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-slate-400"
              />
            </div>
          </div>

          <TaskAttachmentsSection
            task={task}
            attBusy={attBusy}
            setAttBusy={setAttBusy}
            onUploadAttachment={onUploadAttachment}
            onDownloadAttachment={onDownloadAttachment}
            onRemoveAttachment={onRemoveAttachment}
          />

          <TaskOccurrenceTimeline
            task={task}
            timeline={timeline}
            prefs={prefs}
            onToggle={onToggle}
            onSkip={onSkip}
            onReopenOccurrence={onReopenOccurrence}
            onOverrideOccurrence={onOverrideOccurrence}
            onClearOccurrenceOverride={onClearOccurrenceOverride}
            onEndSeries={onEndSeries}
            onEditOccurrence={setEditingOcc}
          />

          {/* Footer metadata */}
          <div className="pt-1 text-[11px] text-slate-400">
            极空间笔记 #{task.id}
            {task.created_at ? ` · 创建于 ${task.created_at.slice(0, 16).replace("T", " ")}` : ""}
            {task.updated_at ? ` · 同步于 ${task.updated_at.slice(0, 16).replace("T", " ")}` : ""}
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        {modal === "date" && (
          <DatePickerModal
            schedule={
              task.repeat && due
                ? {
                    all_day: due.all_day,
                    due: { date: due.date, time: due.all_day ? null : due.time ?? null },
                    timezone: task.schedule.timezone,
                  }
                : task.schedule
            }
            singleOccurrence={Boolean(task.repeat)}
            titleText={task.repeat ? "调整本期排期（仅本次有效，不影响重复模板）" : undefined}
            onClose={() => setModal(null)}
            onSave={(next: Schedule) => {
              setModal(null);
              if (task.repeat && task.series && onOverrideOccurrence) {
                void onOverrideOccurrence(
                  task,
                  task.effective_current_key ?? task.series.cursor,
                  next
                );
              } else {
                void savePatch({ schedule: next });
              }
            }}
            onSaveAndOpenReminder={
              task.repeat
                ? undefined
                : (next: Schedule) => {
                    void savePatch({ schedule: next });
                    setModal("reminder");
                  }
            }
            onSaveAndOpenRepeat={(next: Schedule) => {
              if (task.repeat && task.series && onOverrideOccurrence) {
                void onOverrideOccurrence(
                  task,
                  task.effective_current_key ?? task.series.cursor,
                  next
                );
              } else {
                void savePatch({ schedule: next });
              }
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
      </Suspense>
    </div>
  );
}
