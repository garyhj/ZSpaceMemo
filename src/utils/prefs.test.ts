import assert from "node:assert/strict";
import test from "node:test";

// Minimal DOM storage + Window event shim for running prefs store tests in Node
const storageMap = new Map<string, string>();
const windowListeners = new Map<string, Set<(ev: StorageEvent) => void>>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageMap.set(k, v);
    },
    removeItem: (k: string) => {
      storageMap.delete(k);
    },
    clear: () => {
      storageMap.clear();
    },
  },
});

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    addEventListener: (type: string, cb: (ev: StorageEvent) => void) => {
      const set = windowListeners.get(type) ?? new Set();
      set.add(cb);
      windowListeners.set(type, set);
    },
    removeEventListener: (type: string, cb: (ev: StorageEvent) => void) => {
      windowListeners.get(type)?.delete(cb);
    },
  },
});

const { formatTime, getPrefs, gridOffset, setPrefs, weekdayHeaders } = await import("./prefs.ts");

test("prefs sanitizes malformed stored JSON and preserves valid defaults", () => {
  localStorage.setItem(
    "zsm.ui-prefs.v1",
    JSON.stringify({ timeFormat: "99h", weekStart: "sun", showCompletedGroup: "bad" })
  );
  // Reset cached snapshot by dispatching a storage event
  for (const cb of windowListeners.get("storage") ?? []) {
    cb({ key: "zsm.ui-prefs.v1" } as StorageEvent);
  }
  const prefs = getPrefs();
  assert.equal(prefs.timeFormat, "24h");
  assert.equal(prefs.weekStart, "sun");
  assert.equal(prefs.showCompletedGroup, false);

  setPrefs({ timeFormat: "12h", listsCollapsed: true });
  const updated = getPrefs();
  assert.equal(updated.timeFormat, "12h");
  assert.equal(updated.listsCollapsed, true);
});

test("formatTime converts 24h strings into Chinese 12h periods", () => {
  assert.equal(formatTime("08:05", "24h"), "08:05");
  assert.equal(formatTime("03:15", "12h"), "凌晨 3:15");
  assert.equal(formatTime("09:30", "12h"), "上午 9:30");
  assert.equal(formatTime("12:00", "12h"), "中午 12:00");
  assert.equal(formatTime("15:45", "12h"), "下午 3:45");
  assert.equal(formatTime("21:10", "12h"), "晚上 9:10");
});

test("weekdayHeaders and gridOffset adapt to week start preference", () => {
  assert.deepEqual(weekdayHeaders("mon"), ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
  assert.deepEqual(weekdayHeaders("sun"), ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);

  // 2026-11-01 is a Sunday (getDay() === 0)
  const novFirst = new Date(2026, 10, 1);
  assert.equal(gridOffset(novFirst, "mon"), 6);
  assert.equal(gridOffset(novFirst, "sun"), 0);
});
