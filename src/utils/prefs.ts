import { useSyncExternalStore } from "react";

/**
 * Local-only UI preferences (never written to the NAS).
 * Stored in localStorage so the main window and the floating window share them;
 * cross-window changes propagate through a single module-level `storage` listener.
 */
export interface UiPrefs {
  timeFormat: "24h" | "12h";
  weekStart: "mon" | "sun";
  showCompletedGroup: boolean;
  sidebarCollapsed: boolean;
  listsCollapsed: boolean;
  labelsCollapsed: boolean;
}

const KEY = "zsm.ui-prefs.v1";

const DEFAULTS: UiPrefs = {
  timeFormat: "24h",
  weekStart: "mon",
  showCompletedGroup: false,
  sidebarCollapsed: false,
  listsCollapsed: false,
  labelsCollapsed: false,
};

let cache: UiPrefs | null = null;
const listeners = new Set<() => void>();
let windowBound = false;

function sanitizePrefs(raw: unknown): UiPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULTS };
  }
  const obj = raw as Record<string, unknown>;
  return {
    timeFormat: obj.timeFormat === "12h" ? "12h" : "24h",
    weekStart: obj.weekStart === "sun" ? "sun" : "mon",
    showCompletedGroup:
      typeof obj.showCompletedGroup === "boolean"
        ? obj.showCompletedGroup
        : DEFAULTS.showCompletedGroup,
    sidebarCollapsed:
      typeof obj.sidebarCollapsed === "boolean"
        ? obj.sidebarCollapsed
        : DEFAULTS.sidebarCollapsed,
    listsCollapsed:
      typeof obj.listsCollapsed === "boolean" ? obj.listsCollapsed : DEFAULTS.listsCollapsed,
    labelsCollapsed:
      typeof obj.labelsCollapsed === "boolean" ? obj.labelsCollapsed : DEFAULTS.labelsCollapsed,
  };
}

function notifySubscribers() {
  for (const fn of listeners) fn();
}

function ensureWindowStorageHook() {
  if (windowBound || typeof window === "undefined") return;
  windowBound = true;
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) {
      cache = null;
      notifySubscribers();
    }
  });
}

function subscribePrefs(listener: () => void): () => void {
  ensureWindowStorageHook();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPrefs(): UiPrefs {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? sanitizePrefs(JSON.parse(raw)) : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setPrefs(patch: Partial<UiPrefs>) {
  cache = sanitizePrefs({ ...getPrefs(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // ignore quota / privacy errors
  }
  notifySubscribers();
}

export function usePrefs(): UiPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}

/** Format a stored 24h "HH:MM" string according to the user's time-format preference. */
export function formatTime(time?: string | null, fmt: UiPrefs["timeFormat"] = getPrefs().timeFormat): string {
  if (!time) return "";
  if (fmt === "24h") return time;
  const [hs, ms] = time.split(":");
  const h = Number(hs);
  const period = h < 6 ? "凌晨" : h < 12 ? "上午" : h < 13 ? "中午" : h < 18 ? "下午" : "晚上";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${period} ${h12}:${ms}`;
}

/** Weekday header labels ordered by the week-start preference. */
export function weekdayHeaders(weekStart: UiPrefs["weekStart"], prefix = "周"): string[] {
  const mon = ["一", "二", "三", "四", "五", "六", "日"].map((d) => prefix + d);
  return weekStart === "mon" ? mon : [mon[6], ...mon.slice(0, 6)];
}

/** Offset (in days) from the first day of the month back to the grid start. */
export function gridOffset(firstDayOfMonth: Date, weekStart: UiPrefs["weekStart"]): number {
  const dow = firstDayOfMonth.getDay();
  return weekStart === "mon" ? (dow + 6) % 7 : dow;
}
