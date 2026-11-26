import { useEffect, useState } from "react";

/**
 * Local-only UI preferences (never written to the NAS).
 * Stored in localStorage so the main window and the floating window share them;
 * cross-window changes propagate through the `storage` event.
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
const EVENT = "zsm:prefs-changed";

const DEFAULTS: UiPrefs = {
  timeFormat: "24h",
  weekStart: "mon",
  showCompletedGroup: false,
  sidebarCollapsed: false,
  listsCollapsed: false,
  labelsCollapsed: false,
};

let cache: UiPrefs | null = null;

export function getPrefs(): UiPrefs {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<UiPrefs>) : {}) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setPrefs(patch: Partial<UiPrefs>) {
  cache = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // ignore quota / privacy errors
  }
  window.dispatchEvent(new Event(EVENT));
}

export function usePrefs(): UiPrefs {
  const [prefs, set] = useState<UiPrefs>(getPrefs);
  useEffect(() => {
    const onLocal = () => set(getPrefs());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) {
        cache = null;
        set(getPrefs());
      }
    };
    window.addEventListener(EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return prefs;
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
