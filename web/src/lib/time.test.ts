// Times and calendar days as people read them (lib/time.ts).

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ago, daysUntil, dueLabel, exact, formatDay, timeOfDay } from "@/lib/time";

// A time zone with clock changes: in 2026 Berlin's clocks go forward on
// 29 March (a 23-hour day) and back on 25 October (a 25-hour day). The
// formatters take the zone and the browser's language when lib/time.ts builds
// them, so both are fixed before it loads: Berlin, and American English.
const before = vi.hoisted(() => {
  const was = { zone: process.env.TZ, format: Intl.DateTimeFormat };
  process.env.TZ = "Europe/Berlin";
  class English extends Intl.DateTimeFormat {
    constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      super(locales ?? "en-US", options);
    }
  }
  Intl.DateTimeFormat = English as typeof Intl.DateTimeFormat;
  return was;
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

afterAll(() => {
  process.env.TZ = before.zone;
  Intl.DateTimeFormat = before.format;
});
afterEach(() => void vi.useRealTimers());

describe("ago", () => {
  const now = new Date(2026, 5, 15, 12, 0).getTime();

  it("steps from 'just now' to minutes, hours and days at each boundary", () => {
    expect(ago(now - (MIN - 1), now)).toBe("just now");
    expect(ago(now - MIN, now)).toBe("1m");
    expect(ago(now - (HOUR - 1), now)).toBe("59m");
    expect(ago(now - HOUR, now)).toBe("1h");
    expect(ago(now - (DAY - 1), now)).toBe("23h");
    expect(ago(now - DAY, now)).toBe("1d");
    expect(ago(now - (7 * DAY - 1), now)).toBe("6d");
  });

  it("gives a date after a week, with the year only when it is another year", () => {
    expect(ago(now - 7 * DAY, now)).not.toMatch(/\d+d$/);
    expect(ago(now - 7 * DAY, now)).not.toContain("2026");
    expect(ago(new Date(2025, 11, 20).getTime(), now)).toContain("2025");
  });
});

describe("daysUntil", () => {
  it("counts whole calendar days, across both clock changes", () => {
    expect(new Date(2026, 2, 30).getTime() - new Date(2026, 2, 29).getTime()).toBe(23 * HOUR);
    expect(daysUntil("2026-03-30", "2026-03-29")).toBe(1);
    expect(daysUntil("2026-03-28", "2026-03-30")).toBe(-2);
    expect(daysUntil("2026-10-26", "2026-10-25")).toBe(1);
    expect(daysUntil("2026-12-31", "2026-01-01")).toBe(364);
  });
});

describe("dueLabel", () => {
  const at = (y: number, m: number, d: number, h = 9) => vi.useFakeTimers({ now: new Date(y, m - 1, d, h) });

  it("reads today, tomorrow and late around the day it is", () => {
    at(2026, 6, 15);
    expect(dueLabel("2026-06-15")).toEqual({ text: "Today", tone: "soon" });
    expect(dueLabel("2026-06-16")).toEqual({ text: "Tomorrow", tone: "soon" });
    expect(dueLabel("2026-06-14")).toEqual({ text: "1d late", tone: "late" });
    expect(dueLabel("2026-06-18").tone).toBe("soon");
    expect(dueLabel("2026-06-19").tone).toBe("later");
  });

  it("goes by the person's own calendar day, late at night and on the day the clocks change", () => {
    at(2026, 6, 15, 23);
    expect(dueLabel("2026-06-15").text).toBe("Today");
    at(2026, 3, 29, 0);
    expect(dueLabel("2026-03-30").text).toBe("Tomorrow");
    expect(dueLabel("2026-03-28").text).toBe("1d late");
  });
});

describe("formatters", () => {
  // 15 November 2026, 14:30:05 UTC: 15:30:05 in Berlin.
  const instant = Date.UTC(2026, 10, 15, 14, 30, 5);

  it("exact: the date and the time to the minute", () => expect(exact(instant)).toBe("Nov 15, 2026, 3:30 PM"));
  it("timeOfDay: the clock time", () => expect(timeOfDay(instant)).toBe("3:30 PM"));

  it("formatDay: a calendar day, with the year only when it is not this year", () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 15, 12) });
    expect(formatDay("2026-12-01")).toBe("Dec 1");
    expect(formatDay("2025-12-31")).toBe("Dec 31, 2025");
    expect(formatDay("2026-03-29")).toBe("Mar 29");
  });
});
