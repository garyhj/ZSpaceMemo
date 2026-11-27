import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Inbox,
  Layers,
  List as ListIcon,
  Plus,
  Repeat,
  Tag,
} from "lucide-react";
import { useState } from "react";
import type { Task, TaskView } from "../types";
import { listColorHex, todayStr } from "../utils/date";
import { setPrefs, type UiPrefs } from "../utils/prefs";

function DayBadgeIcon({ label }: { label: string | number }) {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-current text-[9.5px] font-semibold leading-none tracking-tighter tabular-nums">
      {label}
    </span>
  );
}

const PRIMARY_VIEW_ITEMS: {
  key: TaskView;
  label: string;
  icon: (todayDay: number, days: number) => React.ReactNode;
}[] = [
  { key: "all", label: "所有", icon: () => <Layers className="h-4 w-4" strokeWidth={1.75} /> },
  { key: "today", label: "今天", icon: (day) => <DayBadgeIcon label={day} /> },
  { key: "upcoming", label: "最近7天", icon: (_day, days) => <DayBadgeIcon label={days} /> },
  { key: "inbox", label: "收集箱", icon: () => <Inbox className="h-4 w-4" strokeWidth={1.75} /> },
];

const SECONDARY_VIEW_ITEMS: { key: TaskView; label: string; icon: React.ReactNode }[] = [
  { key: "overdue", label: "已逾期", icon: <AlertCircle className="h-4 w-4" strokeWidth={1.75} /> },
  { key: "repeating", label: "重复任务", icon: <Repeat className="h-4 w-4" strokeWidth={1.75} /> },
  { key: "completed", label: "已完成", icon: <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> },
];

interface Props {
  view: TaskView;
  activeList: string | null;
  activeLabel: string | null;
  upcomingDays: number;
  lists: string[];
  listCounts: Record<string, number>;
  allLabels: string[];
  labelCounts: Record<string, number>;
  viewCounts: {
    inbox: number;
    today: number;
    upcoming: number;
    overdue: number;
    repeating: number;
    all: number;
  };
  allActive: readonly Task[];
  prefs: UiPrefs;
  onSelectView: (view: TaskView) => void;
  onSelectList: (listName: string) => void;
  onSelectLabel: (labelName: string) => void;
  onCreateList: (listName: string) => void;
  onDropTaskToList: (task: Task, targetList: string | null) => void;
}

export function AppSidebar({
  view,
  activeList,
  activeLabel,
  upcomingDays,
  lists,
  listCounts,
  allLabels,
  labelCounts,
  viewCounts,
  allActive,
  prefs,
  onSelectView,
  onSelectList,
  onSelectLabel,
  onCreateList,
  onDropTaskToList,
}: Props) {
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [dragOverList, setDragOverList] = useState<string | null>(null);

  if (prefs.sidebarCollapsed) return null;

  const noSubFilter = !activeList && !activeLabel;
  const todayDay = Number(todayStr().slice(8, 10));

  return (
    <aside className="flex w-[212px] shrink-0 flex-col overscroll-contain overflow-y-auto border-r border-slate-200/80 bg-[#fbfbfd] px-2.5 py-3">
      {/* Primary Smart Views: 所有 / 今天 / 最近7天 / 收集箱 */}
      <div className="space-y-0.5">
        {PRIMARY_VIEW_ITEMS.map((item) => {
          const active = noSubFilter && view === item.key;
          const count =
            item.key === "all"
              ? viewCounts.all
              : item.key === "today"
              ? viewCounts.today
              : item.key === "upcoming"
              ? viewCounts.upcoming
              : item.key === "inbox"
              ? viewCounts.inbox
              : 0;
          const label = item.key === "upcoming" ? `最近${upcomingDays}天` : item.label;
          return (
            <button
              key={item.key}
              type="button"
              onDragOver={(e) => {
                if (item.key !== "inbox") return;
                e.preventDefault();
                if (dragOverList !== "__inbox__") setDragOverList("__inbox__");
              }}
              onDragLeave={() => {
                if (dragOverList === "__inbox__") setDragOverList(null);
              }}
              onDrop={(e) => {
                if (item.key !== "inbox") return;
                e.preventDefault();
                setDragOverList(null);
                const id = Number(e.dataTransfer.getData("text/x-zsm-task-id"));
                const t = allActive.find((x) => x.id === id);
                if (t && t.list) {
                  onDropTaskToList(t, null);
                }
              }}
              onClick={() => onSelectView(item.key)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[6px] text-[13.5px] transition ${
                item.key === "inbox" && dragOverList === "__inbox__"
                  ? "bg-blue-100 ring-1 ring-blue-400"
                  : active
                  ? "bg-[#eef3ff] font-medium text-[#191919]"
                  : "text-[#333333] hover:bg-slate-200/50"
              }`}
            >
              <span className={active ? "text-blue-600" : "text-slate-400"}>
                {item.icon(todayDay, upcomingDays)}
              </span>
              <span className="flex-1 text-left">{label}</span>
              {count > 0 && (
                <span className="text-[11.5px] tabular-nums text-slate-400">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="my-2.5 border-t border-slate-100" />

      {/* Collapsible Lists */}
      <div>
        <div className="mb-1 flex items-center justify-between px-1.5 text-[11.5px] font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setPrefs({ listsCollapsed: !prefs.listsCollapsed })}
            className="flex flex-1 items-center gap-1 rounded px-1 py-0.5 text-left transition hover:bg-slate-200/50 hover:text-slate-600"
          >
            <ChevronRight
              className={`h-3 w-3 shrink-0 transition-transform ${
                prefs.listsCollapsed ? "" : "rotate-90"
              }`}
            />
            <span>清单</span>
          </button>
          <button
            type="button"
            title="新建清单"
            onClick={() => {
              if (prefs.listsCollapsed) setPrefs({ listsCollapsed: false });
              setAddingList((v) => !v);
            }}
            className="rounded p-0.5 transition hover:bg-slate-200/70 hover:text-slate-700"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {addingList && !prefs.listsCollapsed && (
          <input
            autoFocus
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newListName.trim()) {
                onCreateList(newListName.trim());
                setNewListName("");
                setAddingList(false);
              }
              if (e.key === "Escape") {
                setAddingList(false);
                setNewListName("");
              }
            }}
            onBlur={() => {
              setAddingList(false);
              setNewListName("");
            }}
            placeholder="清单名称，回车确认"
            className="mb-1.5 w-full rounded-lg border border-blue-400 bg-white px-2.5 py-1 text-xs outline-none"
          />
        )}

        {!prefs.listsCollapsed && (
          <div className="space-y-0.5">
            {lists.map((l) => {
              const active = activeList === l;
              return (
                <button
                  key={l}
                  type="button"
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragOverList !== l) setDragOverList(l);
                  }}
                  onDragLeave={() => {
                    if (dragOverList === l) setDragOverList(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverList(null);
                    const id = Number(e.dataTransfer.getData("text/x-zsm-task-id"));
                    const t = allActive.find((x) => x.id === id);
                    if (t && t.list !== l) {
                      onDropTaskToList(t, l);
                    }
                  }}
                  onClick={() => onSelectList(l)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-[5.5px] text-[13px] transition ${
                    dragOverList === l
                      ? "bg-blue-100 ring-1 ring-blue-400"
                      : active
                      ? "bg-[#eef3ff] font-medium text-[#191919]"
                      : "text-[#333333] hover:bg-slate-200/50"
                  }`}
                >
                  <ListIcon
                    className={`h-3.5 w-3.5 shrink-0 ${active ? "text-blue-600" : "text-slate-400"}`}
                    strokeWidth={1.75}
                  />
                  <span className="flex-1 truncate text-left">{l}</span>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: listColorHex(l) ?? "#4772FA" }}
                  />
                  {(listCounts[l] ?? 0) > 0 && (
                    <span className="min-w-[14px] text-right text-[11.5px] tabular-nums text-slate-400">
                      {listCounts[l]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Collapsible Labels */}
      {allLabels.length > 0 && (
        <>
          <div className="my-2.5 border-t border-slate-100" />
          <div>
            <button
              type="button"
              onClick={() => setPrefs({ labelsCollapsed: !prefs.labelsCollapsed })}
              className="mb-1 flex w-full items-center gap-1 rounded px-2.5 py-0.5 text-left text-[11.5px] font-medium text-slate-400 transition hover:bg-slate-200/50 hover:text-slate-600"
            >
              <ChevronRight
                className={`h-3 w-3 shrink-0 transition-transform ${
                  prefs.labelsCollapsed ? "" : "rotate-90"
                }`}
              />
              <span>标签</span>
            </button>
            {!prefs.labelsCollapsed && (
              <div className="space-y-0.5">
                {allLabels.map((lb) => {
                  const active = activeLabel === lb;
                  return (
                    <button
                      key={lb}
                      type="button"
                      onClick={() => onSelectLabel(lb)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-[5.5px] text-[13px] transition ${
                        active
                          ? "bg-[#eef3ff] font-medium text-[#191919]"
                          : "text-[#333333] hover:bg-slate-200/50"
                      }`}
                    >
                      <Tag
                        className={`h-3.5 w-3.5 shrink-0 ${active ? "text-blue-600" : "text-slate-400"}`}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1 truncate text-left">{lb}</span>
                      <span className="text-[11.5px] tabular-nums text-slate-400">
                        {labelCounts[lb]}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Bottom Secondary Utility Views: 已逾期 / 重复任务 / 已完成 */}
      <div className="mt-auto space-y-0.5 border-t border-slate-100 pt-2.5">
        {SECONDARY_VIEW_ITEMS.map((item) => {
          const active = noSubFilter && view === item.key;
          const count =
            item.key === "overdue"
              ? viewCounts.overdue
              : item.key === "repeating"
              ? viewCounts.repeating
              : 0;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onSelectView(item.key)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[6px] text-[13px] transition ${
                active
                  ? "bg-[#eef3ff] font-medium text-[#191919]"
                  : "text-[#475569] hover:bg-slate-200/50"
              }`}
            >
              <span
                className={
                  active
                    ? item.key === "overdue"
                      ? "text-red-500"
                      : "text-blue-600"
                    : item.key === "overdue" && count > 0
                    ? "text-red-400"
                    : "text-slate-400"
                }
              >
                {item.icon}
              </span>
              <span className="flex-1 text-left">{item.label}</span>
              {count > 0 && (
                <span
                  className={`text-[11.5px] tabular-nums ${
                    item.key === "overdue" ? "font-medium text-red-500" : "text-slate-400"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
