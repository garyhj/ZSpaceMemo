import {
  formatLunarDay,
  formatLunarMonth,
  LUNAR_DAY_NAMES,
  LUNAR_MONTH_NAMES,
} from "./lunar-names";
import {
  CN_HOLIDAY_OVERRIDES,
  LUNAR_MAX_YEAR,
  LUNAR_MIN_YEAR,
  LUNAR_YEARS,
  SOLAR_TERM_BASE_DAYS,
  SOLAR_TERM_NAMES,
  SOLAR_TERMS_HEX,
} from "./lunar-tables";

export { formatLunarDay, formatLunarMonth, LUNAR_DAY_NAMES, LUNAR_MONTH_NAMES };

export interface DayCalendarMeta {
  lunarText: string;
  isHighlight: boolean;
  holidayBadge: "休" | "班" | null;
}

const EPOCH_1900_MS = Date.UTC(1900, 0, 1);

const FIXED_SOLAR_FESTIVALS: Record<string, string> = {
  "01-01": "元旦节",
  "02-14": "情人节",
  "03-08": "妇女节",
  "03-12": "植树节",
  "03-15": "消费者权益日",
  "04-01": "愚人节",
  "05-01": "劳动节",
  "05-04": "青年节",
  "06-01": "儿童节",
  "07-01": "建党节",
  "08-01": "建军节",
  "09-10": "教师节",
  "10-01": "国庆节",
  "10-31": "万圣节前夜",
  "11-01": "万圣节",
  "12-24": "平安夜",
  "12-25": "圣诞节",
};

const FIXED_LUNAR_FESTIVALS: Record<string, string> = {
  "1-1": "春节",
  "1-15": "元宵节",
  "2-2": "龙头节",
  "5-5": "端午节",
  "7-7": "七夕节",
  "8-15": "中秋节",
  "9-9": "重阳节",
  "12-8": "腊八节",
};

const MAX_CACHE_ENTRIES = 2000;
const cache = new Map<string, DayCalendarMeta>();

function parseValidYmd(dateStr: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < LUNAR_MIN_YEAR || y > LUNAR_MAX_YEAR) {
    return null;
  }
  return [y, mo, d];
}

function solarToLunarInternal(
  y: number,
  mo: number,
  d: number
): { year: number; month: number; day: number; isLeap: boolean; monthDays: number } | null {
  const days = Math.round((Date.UTC(y, mo - 1, d) - EPOCH_1900_MS) / 86_400_000);
  let lo = 0;
  let hi = LUNAR_YEARS.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (LUNAR_YEARS[mid][0] <= days) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null;
  const yearIdx = lo - 1;
  const year = LUNAR_MIN_YEAR + yearIdx;
  const [cnyDays, leap, mask] = LUNAR_YEARS[yearIdx];
  let rem = days - cnyDays;
  if (rem < 0) return null;

  let bit = 0;
  for (let m = 1; m <= 12; m++) {
    const mDays = (mask & (1 << bit++)) !== 0 ? 30 : 29;
    if (rem < mDays) {
      return { year, month: m, day: rem + 1, isLeap: false, monthDays: mDays };
    }
    rem -= mDays;
    if (leap === m) {
      const lDays = (mask & (1 << bit++)) !== 0 ? 30 : 29;
      if (rem < lDays) {
        return { year, month: m, day: rem + 1, isLeap: true, monthDays: lDays };
      }
      rem -= lDays;
    }
  }
  return null;
}

function getSolarTerm(y: number, mo: number, d: number): string {
  const hex = SOLAR_TERMS_HEX[y - LUNAR_MIN_YEAR];
  if (!hex) return "";
  const idxA = (mo - 1) * 2;
  const idxB = idxA + 1;
  const word = parseInt(mo <= 6 ? hex.slice(0, 6) : hex.slice(6, 12), 16);
  const shiftA = (idxA % 12) * 2;
  const shiftB = (idxB % 12) * 2;
  const dayA = SOLAR_TERM_BASE_DAYS[idxA] + ((word >>> shiftA) & 0x3);
  if (d === dayA) return SOLAR_TERM_NAMES[idxA];
  const dayB = SOLAR_TERM_BASE_DAYS[idxB] + ((word >>> shiftB) & 0x3);
  if (d === dayB) return SOLAR_TERM_NAMES[idxB];
  return "";
}

function getSolarFestival(y: number, mo: number, d: number): string {
  const key = `${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (FIXED_SOLAR_FESTIVALS[key]) return FIXED_SOLAR_FESTIVALS[key];
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  if (mo === 3 && dow === 1 && d + 7 > 31) return "全国中小学生安全教育日";
  if (mo === 5 && dow === 0 && d >= 8 && d <= 14) return "母亲节";
  if (mo === 5 && dow === 0 && d >= 15 && d <= 21) return "全国助残日";
  if (mo === 6 && dow === 0 && d >= 15 && d <= 21) return "父亲节";
  if (mo === 9 && dow === 6 && d >= 15 && d <= 21) return "全民国防教育日";
  if (mo === 10 && dow === 1 && d <= 7) return "世界住房日";
  if (mo === 11 && dow === 4 && d >= 22 && d <= 28) return "感恩节";
  return "";
}

function getHolidayBadge(y: number, mo: number, d: number): "休" | "班" | null {
  const target = y * 10_000 + mo * 100 + d;
  let lo = 0;
  let hi = CN_HOLIDAY_OVERRIDES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = CN_HOLIDAY_OVERRIDES[mid];
    const entryYmd = entry >>> 1;
    if (entryYmd === target) return (entry & 1) === 1 ? "班" : "休";
    if (entryYmd < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
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
  const lun = solarToLunarInternal(y, m, d);
  if (!lun) {
    return { lunarText: "", isHighlight: false, holidayBadge: null };
  }

  const lunarFest = lun.isLeap
    ? ""
    : lun.month === 12 && lun.day === lun.monthDays
    ? "除夕"
    : FIXED_LUNAR_FESTIVALS[`${lun.month}-${lun.day}`] ?? "";
  const solarFest = getSolarFestival(y, m, d);
  const jieQi = getSolarTerm(y, m, d);

  let lunarText = formatLunarDay(lun.day);
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
  } else if (lun.day === 1) {
    lunarText = formatLunarMonth(lun.month, lun.isLeap);
  }

  const holidayBadge = getHolidayBadge(y, m, d);
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
  const lun = ymd ? solarToLunarInternal(ymd[0], ymd[1], ymd[2]) : null;
  if (!lun) {
    return { year: 2026, month: 1, day: 1, isLeap: false, label: "正月初一" };
  }
  return {
    year: lun.year,
    month: lun.month,
    day: lun.day,
    isLeap: lun.isLeap,
    label: `${formatLunarMonth(lun.month, lun.isLeap)}${formatLunarDay(lun.day)}`,
  };
}
