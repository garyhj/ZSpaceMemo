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
