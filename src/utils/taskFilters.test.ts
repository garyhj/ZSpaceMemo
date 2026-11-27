import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../types.ts";
import { computeSidebarStats, computeViewTasks } from "./taskFilters.ts";

function makeTask(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `任务 ${id}`,
    description: "",
    rich_body_protected: false,
    status: "pending",
    priority: "normal",
    list: null,
    labels: [],
    pinned: false,
    schedule: { all_day: true, due: null, timezone: "Asia/Shanghai" },
    reminders: [],
    repeat: null,
    series: null,
    effective_current_key: null,
    is_overdue: false,
    completed_at: null,
    created_at: null,
    updated_at: null,
    source: "zspace_notebook",
    meta_state: "ok",
    rev: 1,
    etag: `etag-${id}`,
    ...overrides,
  };
}

test("computeSidebarStats counts inbox, today, upcoming, overdue, lists, and labels", () => {
  const fixedNow = new Date("2026-11-26T10:00:00").getTime();
  const active: Task[] = [
    makeTask(1, { list: "工作", labels: ["紧急"], is_overdue: true, schedule: { all_day: true, due: { date: "2026-11-25", time: null }, timezone: "Asia/Shanghai" } }),
    makeTask(2, { list: "工作", labels: ["例会"], schedule: { all_day: true, due: { date: "2026-11-26", time: null }, timezone: "Asia/Shanghai" } }),
    makeTask(3, { list: "生活", schedule: { all_day: true, due: { date: "2026-11-28", time: null }, timezone: "Asia/Shanghai" } }),
    makeTask(4, {}), // inbox
  ];
  const completed: Task[] = [
    makeTask(5, { status: "completed", list: "归档清单", completed_at: "2026-11-26T09:00:00" }),
  ];

  const stats = computeSidebarStats(active, completed, ["自定义空清单"], 7, true, fixedNow);
  assert.deepEqual(stats.lists, ["工作", "归档清单", "生活", "自定义空清单"].sort());
  assert.equal(stats.listCounts["工作"], 2);
  assert.equal(stats.viewCounts.overdue, 1);
  assert.equal(stats.viewCounts.today, 2); // today + overdue when showOverdueInToday=true
  assert.equal(stats.viewCounts.upcoming, 1);
  assert.equal(stats.viewCounts.inbox, 1);
  assert.equal(stats.viewCounts.all, 4);
  assert.deepEqual(stats.labelCounts, { 紧急: 1, 例会: 1 });
});

test("computeViewTasks splits today overdue and groups upcoming with 未安排 last", () => {
  const fixedNow = new Date("2026-11-26T10:00:00").getTime();
  const tasks: Task[] = [
    makeTask(1, { is_overdue: true, schedule: { all_day: true, due: { date: "2026-11-24", time: null }, timezone: "Asia/Shanghai" } }),
    makeTask(2, { schedule: { all_day: true, due: { date: "2026-11-26", time: null }, timezone: "Asia/Shanghai" } }),
    makeTask(3, {}),
  ];
  const todayRes = computeViewTasks({
    tasks,
    completedTasks: [],
    view: "today",
    activeList: null,
    activeLabel: null,
    nowMs: fixedNow,
  });
  assert.equal(todayRes.overdueToday.length, 1);
  assert.equal(todayRes.normalToday.length, 2);

  const upRes = computeViewTasks({
    tasks: [tasks[2], tasks[1]],
    completedTasks: [],
    view: "upcoming",
    activeList: null,
    activeLabel: null,
    nowMs: fixedNow,
  });
  assert.deepEqual(
    upRes.upcomingGroups.map(([k]) => k),
    ["2026-11-26", "未安排"]
  );
});
