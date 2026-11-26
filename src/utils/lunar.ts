import { HolidayUtil, Solar } from "lunar-javascript";
import {
  formatLunarDay,
  formatLunarMonth,
  LUNAR_DAY_NAMES,
  LUNAR_MONTH_NAMES,
} from "./lunar-names";

export { formatLunarDay, formatLunarMonth, LUNAR_DAY_NAMES, LUNAR_MONTH_NAMES };

export interface DayCalendarMeta {
  lunarText: string;
  isHighlight: boolean;
  holidayBadge: "休" | "班" | null;
}

const MAX_CACHE_ENTRIES = 2000;
const cache = new Map<string, DayCalendarMeta>();

function parseValidYmd(dateStr: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return [y, mo, d];
}

/**
 * Compute offline Chinese lunar day / solar term / traditional festival / statutory holiday badge
 * for any `YYYY-MM-DD` date string.
 */
export function getDayCalendarMeta(dateStr: string): DayCalendarMeta {
  const hit = cache.get(dateStr);
  if (hit) return hit;

  const ymd = parseValidYmd(dateStr);
  if (!ymd) {
    return { lunarText: "", isHighlight: false, holidayBadge: null };
  }
  const [y, m, d] = ymd;
  const solar = Solar.fromYmd(y, m, d);
  const lunar = solar.getLunar();

  const solarFest = solar.getFestivals()[0];
  const lunarFest = lunar.getFestivals()[0];
  const jieQi = lunar.getJieQi();

  let lunarText = lunar.getDayInChinese();
  let isHighlight = false;

  if (lunarFest) {
    lunarText = lunarFest.slice(0, 4);
    isHighlight = true;
  } else if (solarFest) {
    lunarText = solarFest.slice(0, 4);
    isHighlight = true;
  } else if (jieQi) {
    lunarText = jieQi;
    isHighlight = true;
  } else if (lunar.getDay() === 1) {
    lunarText = `${lunar.getMonthInChinese()}月`;
  }

  let holidayBadge: "休" | "班" | null = null;
  const h = HolidayUtil.getHoliday(y, m, d);
  if (h) {
    holidayBadge = h.isWork() ? "班" : "休";
  }

  const meta: DayCalendarMeta = { lunarText, isHighlight, holidayBadge };
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(dateStr, meta);
  return meta;
}

export function getLunarCoords(dateStr: string): {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
  label: string;
} {
  const ymd = parseValidYmd(dateStr);
  if (!ymd) {
    return { year: 2026, month: 1, day: 1, isLeap: false, label: "正月初一" };
  }
  const [y, m, d] = ymd;
  const lunar = Solar.fromYmd(y, m, d).getLunar();
  const rawMonth = lunar.getMonth();
  const month = Math.abs(rawMonth);
  const isLeap = rawMonth < 0;
  const day = lunar.getDay();
  return {
    year: lunar.getYear(),
    month,
    day,
    isLeap,
    label: `${formatLunarMonth(month, isLeap)}${formatLunarDay(day)}`,
  };
}
