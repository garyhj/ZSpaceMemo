import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../types.ts";
import {
  addDays,
  dateLabel,
  describeRepeatZh,
  diffDays,
  effectiveDue,
  isTaskOverdue,
  quickParse,
  todayStr,
} from "./date.ts";
import { getDayCalendarMeta, getLunarCoords } from "./lunar.ts";

function makeBaseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "测试任务",
    description: "",
    rich_body_protected: false,
    status: "pending",
    priority: "normal",
    list: null,
    labels: [],
    pinned: false,
    schedule: { all_day: true, due: { date: "2026-11-26", time: null }, timezone: "Asia/Shanghai" },
    reminders: [],
    repeat: null,
    series: null,
    effective_current_key: null,
    is_overdue: null,
    completed_at: null,
    created_at: null,
    updated_at: null,
    source: "zspace_notebook",
    meta_state: "ok",
    rev: 1,
    etag: "etag-1",
    ...overrides,
  };
}

test("quickParse extracts Chinese dates, times, priority, and list tokens cleanly", () => {
  const tomorrow = addDays(todayStr(), 1);
  const res = quickParse("明天 下午3点半 提交周报 !高 #工作", null, "normal");
  assert.equal(res.title, "提交周报");
  assert.equal(res.dueDate, tomorrow);
  assert.equal(res.dueTime, "15:30");
  assert.equal(res.priority, "high");
  assert.equal(res.list, "工作");
  assert.equal(res.tokens.length, 4);
});

test("quickParse infers today when time is given without explicit date", () => {
  const res = quickParse("09:45 晨会", null, "normal", "默认");
  assert.equal(res.title, "晨会");
  assert.equal(res.dueDate, todayStr());
  assert.equal(res.dueTime, "09:45");
  assert.equal(res.list, "默认");
});

test("effectiveDue prefers effective_current_key and applies per-occurrence overrides", () => {
  const task = makeBaseTask({
    status: "active",
    schedule: { all_day: false, due: { date: "2026-11-01", time: "09:00" }, timezone: "Asia/Shanghai" },
    repeat: {
      freq: "daily",
      interval: 1,
      dtstart: "2026-11-01",
      basis: "schedule",
      catch_up: "latest",
      calendar: "gregorian",
      end: { type: "never" },
    },
    series: {
      cursor: "2026-11-20",
      history: [],
      overrides: {
        "2026-11-26": {
          schedule: {
            all_day: false,
            due: { date: "2026-11-27", time: "14:00" },
            timezone: "Asia/Shanghai",
          },
        },
      },
    },
    effective_current_key: "2026-11-26",
  });
  const due = effectiveDue(task);
  assert.deepEqual(due, { date: "2026-11-27", time: "14:00", all_day: false });
});

test("isTaskOverdue respects terminal status and backend-computed is_overdue", () => {
  const completedOld = makeBaseTask({
    status: "completed",
    schedule: { all_day: true, due: { date: "2020-01-01", time: null }, timezone: "UTC" },
    is_overdue: true,
  });
  assert.equal(isTaskOverdue(completedOld), false);

  const endedOld = makeBaseTask({ status: "ended", is_overdue: true });
  assert.equal(isTaskOverdue(endedOld), false);

  const activeServerOverdue = makeBaseTask({ status: "pending", is_overdue: true });
  assert.equal(isTaskOverdue(activeServerOverdue), true);

  const activeServerNotOverdue = makeBaseTask({
    status: "pending",
    schedule: { all_day: true, due: { date: "2020-01-01", time: null }, timezone: "UTC" },
    is_overdue: false,
  });
  assert.equal(isTaskOverdue(activeServerNotOverdue), false);
});

test("describeRepeatZh formats until and lunar rules accurately", () => {
  const weeklyUntil = describeRepeatZh({
    freq: "weekly",
    interval: 2,
    by_weekday: ["MO", "FR"],
    dtstart: "2026-11-02",
    basis: "schedule",
    catch_up: "latest",
    calendar: "gregorian",
    end: { type: "until", until: "2026-12-31" },
  });
  assert.match(weeklyUntil, /每 2 周 周一、周五/);
  assert.match(weeklyUntil, /至 2026-12-31/);

  const lunarAnnual = describeRepeatZh({
    freq: "yearly",
    interval: 1,
    dtstart: "2026-02-17",
    basis: "schedule",
    catch_up: "each",
    calendar: "lunar",
    lunar: { month: 1, day: 1, leap: "both" },
    end: { type: "count", count: 5 },
  });
  assert.match(lunarAnnual, /每年 农历正月初一（含闰月）/);
  assert.match(lunarAnnual, /共 5 次/);
});

test("date helpers handle non-date strings and lunar metadata offline", () => {
  assert.equal(dateLabel("未安排"), "未安排");
  assert.equal(diffDays("2026-11-26", addDays("2026-11-26", 5)), 5);

  const meta = getDayCalendarMeta("2026-10-01");
  assert.equal(meta.holidayBadge, "休");
  assert.equal(meta.isHighlight, true);

  const spring = getLunarCoords("2026-02-17");
  assert.equal(spring.month, 1);
  assert.equal(spring.day, 1);
  assert.equal(spring.label, "正月初一");
});
