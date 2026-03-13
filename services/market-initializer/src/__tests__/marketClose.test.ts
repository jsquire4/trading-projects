import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeMarketCloseUnix } from "../initializer.ts";

// ---------------------------------------------------------------------------
// Mock isMarketDay to control weekend/holiday behavior without Tradier calls
// ---------------------------------------------------------------------------

vi.mock("../../../automation/src/timezone.js", async () => {
  const actual = await vi.importActual<typeof import("../../../automation/src/timezone.js")>(
    "../../../automation/src/timezone.js",
  );
  return {
    ...actual,
    isMarketDay: vi.fn(),
  };
});

import { isMarketDay } from "../../../automation/src/timezone.js";
const mockIsMarketDay = vi.mocked(isMarketDay);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Date for a specific ET datetime. Accounts for EST (UTC-5). */
function etDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number = 0,
): Date {
  // EST offset is UTC-5 (standard time). For simplicity in tests we use UTC-5.
  // The actual DST handling is done by getETOffsetMinutes which we don't mock.
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

/** Extract the ET date from a unix timestamp for assertions. */
function unixToETComponents(unix: number): { year: number; month: number; day: number; hour: number } {
  const d = new Date(unix * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeMarketCloseUnix — weekend/holiday skipping", () => {
  let realDateNow: () => number;

  beforeEach(() => {
    realDateNow = Date.now;
    mockIsMarketDay.mockReset();
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  it("Friday after 4 PM ET => next Monday 4 PM ET", async () => {
    // Friday March 13, 2026 at 5 PM ET (past 4 PM close)
    const friday5pm = etDate(2026, 3, 13, 17, 0);
    Date.now = () => friday5pm.getTime();

    // isMarketDay: Saturday=false, Sunday=false, Monday=true
    mockIsMarketDay
      .mockResolvedValueOnce(false) // Saturday
      .mockResolvedValueOnce(false) // Sunday
      .mockResolvedValueOnce(true); // Monday

    const result = await computeMarketCloseUnix(friday5pm);
    const et = unixToETComponents(result);

    expect(et.year).toBe(2026);
    expect(et.month).toBe(3);
    expect(et.day).toBe(16); // Monday
    expect(et.hour).toBe(16); // 4 PM ET
  });

  it("Saturday => next Monday 4 PM ET", async () => {
    // Saturday March 14, 2026 at 10 AM ET
    const saturday = etDate(2026, 3, 14, 10, 0);
    Date.now = () => saturday.getTime();

    // Saturday's 4 PM is in the future relative to 10 AM, but isMarketDay
    // should be checked for today first. Since it's Saturday, we skip.
    mockIsMarketDay
      .mockResolvedValueOnce(false) // Saturday (today check)
      .mockResolvedValueOnce(false) // Sunday
      .mockResolvedValueOnce(true); // Monday

    const result = await computeMarketCloseUnix(saturday);
    const et = unixToETComponents(result);

    expect(et.year).toBe(2026);
    expect(et.month).toBe(3);
    expect(et.day).toBe(16); // Monday
    expect(et.hour).toBe(16); // 4 PM ET
  });

  it("Friday before 4 PM ET on a market day => same day 4 PM ET", async () => {
    // Friday March 13, 2026 at 2 PM ET (before 4 PM close)
    const friday2pm = etDate(2026, 3, 13, 14, 0);
    Date.now = () => friday2pm.getTime();

    // Today is a market day
    mockIsMarketDay.mockResolvedValueOnce(true);

    const result = await computeMarketCloseUnix(friday2pm);
    const et = unixToETComponents(result);

    expect(et.year).toBe(2026);
    expect(et.month).toBe(3);
    expect(et.day).toBe(13); // Same Friday
    expect(et.hour).toBe(16); // 4 PM ET
  });

  it("Thursday after 4 PM with Friday being a holiday => next Monday 4 PM ET", async () => {
    // Thursday April 2, 2026 at 5 PM ET (past 4 PM, next day is Good Friday 2026-04-03)
    const thursday5pm = etDate(2026, 4, 2, 17, 0);
    Date.now = () => thursday5pm.getTime();

    mockIsMarketDay
      .mockResolvedValueOnce(false) // Friday (Good Friday holiday)
      .mockResolvedValueOnce(false) // Saturday
      .mockResolvedValueOnce(false) // Sunday
      .mockResolvedValueOnce(true); // Monday

    const result = await computeMarketCloseUnix(thursday5pm);
    const et = unixToETComponents(result);

    expect(et.year).toBe(2026);
    expect(et.month).toBe(4);
    expect(et.day).toBe(6); // Monday April 6
    expect(et.hour).toBe(16); // 4 PM ET
  });

  it("normal weekday after 4 PM => next weekday 4 PM ET", async () => {
    // Tuesday March 10, 2026 at 5 PM ET
    const tuesday5pm = etDate(2026, 3, 10, 17, 0);
    Date.now = () => tuesday5pm.getTime();

    mockIsMarketDay.mockResolvedValueOnce(true); // Wednesday

    const result = await computeMarketCloseUnix(tuesday5pm);
    const et = unixToETComponents(result);

    expect(et.year).toBe(2026);
    expect(et.month).toBe(3);
    expect(et.day).toBe(11); // Wednesday
    expect(et.hour).toBe(16); // 4 PM ET
  });
});
