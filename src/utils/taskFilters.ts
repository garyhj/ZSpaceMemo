import type { AuthStatus, Task, TaskView } from "../types";
import { effectiveDue, formatDate, isTaskOverdue, todayStr } from "./date";
import { groupByKey } from "./format";

export const ALL_VIEW_LABELS: Record<TaskView, string> = {
  all: "所有",
  today: "今天",
  upcoming: "最近7天",
  inbox: "收集箱",
  overdue: "已逾期",
  repeating: "重复任务",
  completed: "已完成",
};

export function customListsStorageKey(authStatus: AuthStatus | null): string {
  const acct = authStatus?.nas_id || authStatus?.profile || "default";
  return `zsm_custom_lists_v1:${acct}`;
}

export function loadSavedCustomLists(authStatus: AuthStatus | null): string[] {
  try {
    const raw = localStorage.getItem(customListsStorageKey(authStatus));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0))
    );
  } catch {
    return [];
  }
}

export function computeSidebarStats(
  allActive: readonly Task[],
  completedTasks: readonly Task[],
  customLists: readonly string[],
  upcomingDays: number,
  showOverdueInToday: boolean,
  nowMs = Date.now()
) {
  const listSet = new Set<string>(customLists);
  for (const t of allActive) {
    if (t.list) listSet.add(t.list);
  }
  for (const t of completedTasks) {
    if (t.list) listSet.add(t.list);
  }
  const lists = Array.from(listSet).sort();

  const today = formatDate(new Date(nowMs));
  const upcomingEnd = formatDate(new Date(nowMs + upcomingDays * 86_400_000));
  let inbox = 0;
  let todayCount = 0;
  let upcoming = 0;
  let overdue = 0;
  let repeating = 0;
  const listCounts: Record<string, number> = {};
  const labelCounts: Record<string, number> = {};

  for (const t of allActive) {
    if (t.list) listCounts[t.list] = (listCounts[t.list] ?? 0) + 1;
    for (const lb of t.labels) {
      labelCounts[lb] = (labelCounts[lb] ?? 0) + 1;
    }
    if (t.repeat) repeating++;
    const due = effectiveDue(t);
    const od = isTaskOverdue(t);
    if (od) overdue++;
    if (!t.repeat && !due) inbox++;
    if (due?.date === today || (showOverdueInToday && od)) {
      todayCount++;
    }
    if (due && due.date > today && due.date <= upcomingEnd) {
      upcoming++;
    }
  }

  return {
    lists,
    listCounts,
    allLabels: Object.keys(labelCounts).sort(),
    labelCounts,
    viewCounts: {
      inbox,
      today: todayCount,
      upcoming,
      overdue,
      repeating,
      all: allActive.length,
    },
  };
}

export function computeViewTasks({
  tasks,
  completedTasks,
  view,
  activeList,
  activeLabel,
  nowMs = Date.now(),
}: {
  tasks: readonly Task[];
  completedTasks: readonly Task[];
  view: TaskView;
  activeList: string | null;
  activeLabel: string | null;
  nowMs?: number;
}) {
  const displayedTasks = activeList
    ? tasks.filter((t) => t.list === activeList)
    : activeLabel
    ? tasks.filter((t) => t.labels.includes(activeLabel))
    : tasks;

  const noSubFilter = !activeList && !activeLabel;
  const overdueToday =
    noSubFilter && view === "today" ? displayedTasks.filter(isTaskOverdue) : [];
  const normalToday =
    noSubFilter && view === "today"
      ? displayedTasks.filter((t) => !isTaskOverdue(t))
      : displayedTasks;

  const upcomingGroups =
    noSubFilter && view === "upcoming"
      ? Object.entries(
          groupByKey(displayedTasks, (t) => effectiveDue(t)?.date ?? "未安排")
        ).sort(([a], [b]) => (a === "未安排" ? 1 : b === "未安排" ? -1 : a.localeCompare(b)))
      : [];

  const todayKey = formatDate(new Date(nowMs)) || todayStr();
  const upcomingAgo = formatDate(new Date(nowMs - 7 * 86_400_000));
  const completedDay = (t: Task) => (t.completed_at ? formatDate(new Date(t.completed_at)) : null);

  const completedForView =
    view === "completed"
      ? []
      : completedTasks
          .filter((t) => {
            if (t.repeat || t.status !== "completed") return false;
            if (activeList) return t.list === activeList;
            if (activeLabel) return t.labels.includes(activeLabel);
            const due = t.schedule.due?.date ?? null;
            if (view === "today") return due === todayKey || completedDay(t) === todayKey;
            if (view === "inbox") return !due;
            if (view === "all") {
              const d = completedDay(t);
              return d !== null && d >= upcomingAgo;
            }
            return false;
          })
          .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
          .slice(0, 50);

  return {
    noSubFilter,
    displayedTasks,
    overdueToday,
    normalToday,
    upcomingGroups,
    completedForView,
  };
}
