/**
 * ET Timezone Helpers
 *
 * DST-aware conversion between America/New_York and UTC.
 * Uses Intl.DateTimeFormat for correct offset detection — no third-party tz libs.
 */

import { createLogger } from "../../shared/src/alerting.js";

const log = createLogger("automation-scheduler:timezone");

const ET_TIMEZONE = "America/New_York";

// NYSE holidays for 2026 (and 2025 for completeness). Update annually.
// Source: https://www.nyse.com/markets/hours-calendars
const NYSE_HOLIDAYS: Set<string> = new Set([
  // 2025
  "2025-01-01", // New Year's Day
  "2025-01-20", // MLK Jr. Day
  "2025-02-17", // Presidents' Day
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving
  "2025-12-25", // Christmas Day
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas Day
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // MLK Jr. Day
  "2027-02-15", // Presidents' Day
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (observed)
  "2027-07-05", // Independence Day (observed)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas Day (observed)
  // 2028
  // Note: 2028-01-01 (New Year's Day) falls on Saturday. NYSE does not observe
  // on prior Friday when New Year's falls on Saturday, so it is correctly omitted.
  "2028-01-17", // MLK Jr. Day
  "2028-02-21", // Presidents' Day
  "2028-04-14", // Good Friday
  "2028-05-29", // Memorial Day
  "2028-06-19", // Juneteenth
  "2028-07-04", // Independence Day
  "2028-09-04", // Labor Day
  "2028-11-23", // Thanksgiving
  "2028-12-25", // Christmas Day
]);

const maxHolidayYear = 2028; // Update when adding new years
if (new Date().getFullYear() > maxHolidayYear) {
  log.warn(`NYSE holiday list may be stale — last updated for ${maxHolidayYear}`);
}

/**
 * Parse the current ET date/time components from Intl formatters.
 * This correctly handles DST transitions without manual offset tables.
 */
function getETComponents(date: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun, 6=Sat
} {
  // Use en-US with specific parts to extract numeric components
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";

  const weekdayStr = get("weekday");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    weekday: weekdayMap[weekdayStr] ?? 0,
  };
}

/**
 * Get the UTC offset (in minutes) for ET at a specific date.
 * Returns e.g. -300 for EST (UTC-5) or -240 for EDT (UTC-4).
 */
export function getETOffsetMinutes(date: Date = new Date()): number {
  // Use Intl.DateTimeFormat to get ET hours/minutes, then compute offset
  // from UTC. This avoids new Date(localeString) which is implementation-defined (SH-6).
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);

  const utcParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);

  const get = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  const etMinutes = get(etParts, "day") * 24 * 60 + get(etParts, "hour") * 60 + get(etParts, "minute");
  const utcMinutes = get(utcParts, "day") * 24 * 60 + get(utcParts, "hour") * 60 + get(utcParts, "minute");

  // Handle month/day boundary (e.g., ET is 11:30 PM on the 14th, UTC is 4:30 AM on the 15th)
  let diff = etMinutes - utcMinutes;
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;

  return diff;
}

/**
 * Returns the next occurrence of the given ET time as a UTC Date.
 * If the time has already passed today (in ET), returns tomorrow's occurrence.
 */
export function getNextETTime(hour: number, minute: number): Date {
  const now = new Date();
  const et = getETComponents(now);

  // Build a candidate date: today at the requested ET time
  // Start by constructing the date string in ET
  let candidateYear = et.year;
  let candidateMonth = et.month;
  let candidateDay = et.day;

  const etNowMinutes = et.hour * 60 + et.minute;
  const targetMinutes = hour * 60 + minute;

  if (etNowMinutes >= targetMinutes) {
    // Time already passed today in ET — advance to tomorrow
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tmrw = getETComponents(tomorrow);
    candidateYear = tmrw.year;
    candidateMonth = tmrw.month;
    candidateDay = tmrw.day;
  }

  // Build a date string that we can parse, then adjust for ET offset
  // Create a UTC date and subtract the ET offset to get the correct UTC time
  const dateStr = `${candidateYear}-${String(candidateMonth).padStart(2, "0")}-${String(candidateDay).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

  // Parse as if UTC, then adjust by ET offset
  const asUtc = new Date(dateStr + "Z");

  // Get ET offset at the candidate time (handles DST correctly)
  const offsetMin = getETOffsetMinutes(asUtc);
  const utcTime = new Date(asUtc.getTime() - offsetMin * 60_000);

  // Handle DST fall-back ambiguity (1:00-1:59 AM ET occurs twice).
  // The offset computed above may correspond to EST (post-fallback).
  // Re-check: if the offset at utcTime differs, prefer EDT (first occurrence).
  const verifyOffset = getETOffsetMinutes(utcTime);
  if (verifyOffset !== offsetMin) {
    // Use the earlier (EDT) offset to pick the first occurrence
    const edtOffset = Math.max(offsetMin, verifyOffset);
    return new Date(asUtc.getTime() - edtOffset * 60_000);
  }

  return utcTime;
}

/**
 * Returns the current hour in ET (0-23).
 */
export function getCurrentETHour(): number {
  return getETComponents().hour;
}

/**
 * Returns today's date in ET as "YYYY-MM-DD".
 */
export function getTodayET(): string {
  const et = getETComponents();
  return `${et.year}-${String(et.month).padStart(2, "0")}-${String(et.day).padStart(2, "0")}`;
}

/**
 * Checks if today is a US equity trading day (Mon-Fri, not an NYSE holiday).
 *
 * Uses the hardcoded NYSE holiday list (maintained through 2028).
 */
let _cachedDayKey: string | null = null;
let _cachedResult: boolean | null = null;

export async function isMarketDay(date: Date = new Date()): Promise<boolean> {
  const et = getETComponents(date);
  const dayKey = `${et.year}-${String(et.month).padStart(2, "0")}-${String(et.day).padStart(2, "0")}`;
  if (dayKey === _cachedDayKey && _cachedResult !== null) return _cachedResult;

  // Weekend check
  if (et.weekday === 0 || et.weekday === 6) {
    _cachedDayKey = dayKey;
    _cachedResult = false;
    return false;
  }

  const dateStr = `${et.year}-${String(et.month).padStart(2, "0")}-${String(et.day).padStart(2, "0")}`;
  const result = !NYSE_HOLIDAYS.has(dateStr);
  _cachedDayKey = dayKey;
  _cachedResult = result;
  return result;
}
