import { HolidayUtil, Solar } from "lunar-javascript";

export interface DayCalendarMeta {
  lunarText: string;
  isHighlight: boolean;
  holidayBadge: "休" | "班" | null;
}

const cache = new Map<string, DayCalendarMeta>();

/**
 * Compute offline Chinese lunar day / solar term / traditional festival / statutory holiday badge
 * for any `YYYY-MM-DD` date string.
 */
export function getDayCalendarMeta(dateStr: string): DayCalendarMeta {
  const hit = cache.get(dateStr);
  if (hit) return hit;

  const [y, m, d] = dateStr.split("-").map(Number);
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
  cache.set(dateStr, meta);
  return meta;
}

export const LUNAR_MONTH_NAMES = [
  "正月",
  "二月",
  "三月",
  "四月",
  "五月",
  "六月",
  "七月",
  "八月",
  "九月",
  "十月",
  "冬月",
  "腊月",
];

export const LUNAR_DAY_NAMES = [
  "初一",
  "初二",
  "初三",
  "初四",
  "初五",
  "初六",
  "初七",
  "初八",
  "初九",
  "初十",
  "十一",
  "十二",
  "十三",
  "十四",
  "十五",
  "十六",
  "十七",
  "十八",
  "十九",
  "二十",
  "廿一",
  "廿二",
  "廿三",
  "廿四",
  "廿五",
  "廿六",
  "廿七",
  "廿八",
  "廿九",
  "三十",
];

export function formatLunarMonth(month: number, isLeap = false): string {
  const base = LUNAR_MONTH_NAMES[Math.max(0, Math.min(11, month - 1))] ?? "正月";
  return isLeap ? `闰${base}` : base;
}

export function formatLunarDay(day: number): string {
  return LUNAR_DAY_NAMES[Math.max(0, Math.min(29, day - 1))] ?? `${day}日`;
}

export function getLunarCoords(dateStr: string): {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
  label: string;
} {
  const [y, m, d] = dateStr.split("-").map(Number);
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
