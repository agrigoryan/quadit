// PINNING (old copies): what each copy of day arithmetic returns today.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as db from "@/docs/db/dates";
import * as ins from "@/insights/lib/format";
import { daysUntil, today } from "@/lib/time";
import { isWeekend, monthsOf } from "@/insights/timeline/scale";

const HOUR = 3_600_000;

const ADD: [string, number, string][] = [
  ["2026-01-31", 1, "2026-02-01"],
  ["2026-02-28", 1, "2026-03-01"],
  ["2024-02-28", 1, "2024-02-29"],
  ["2024-02-29", 1, "2024-03-01"],
  ["2024-03-01", -1, "2024-02-29"],
  ["2100-02-28", 1, "2100-03-01"],
  ["2026-12-31", 1, "2027-01-01"],
  ["2027-01-01", -1, "2026-12-31"],
  ["2026-03-28", 2, "2026-03-30"],
  ["2026-03-07", 2, "2026-03-09"],
  ["2026-10-24", 2, "2026-10-26"],
  ["2026-11-01", 1, "2026-11-02"],
  ["2026-11-15", -45, "2026-10-01"],
  ["2026-11-15", 0, "2026-11-15"],
  ["1970-01-01", -1, "1969-12-31"],
];

const BETWEEN: [string, string, number][] = [
  ["2026-03-29", "2026-03-30", 1],
  ["2026-03-30", "2026-03-28", -2],
  ["2026-10-25", "2026-10-26", 1],
  ["2026-03-08", "2026-03-09", 1],
  ["2026-11-01", "2026-11-02", 1],
  ["2026-01-01", "2026-12-31", 364],
  ["2024-01-01", "2025-01-01", 366],
  ["2026-12-31", "2027-01-01", 1],
  ["2026-03-01", "2026-02-28", -1],
  ["2026-11-15", "2026-11-15", 0],
  ["1969-12-31", "1970-01-02", 2],
];

// 0 is Monday.
const WEEKDAY: [string, number][] = [
  ["2026-11-16", 0],
  ["2026-11-15", 6],
  ["2026-11-14", 5],
  ["1970-01-01", 3],
  ["1969-12-29", 0],
  ["2024-02-29", 3],
  ["2026-03-29", 6],
];

const ADD_MONTHS: [string, number, string][] = [
  ["2026-01-31", 1, "2026-02-01"],
  ["2026-12-15", 1, "2027-01-01"],
  ["2026-01-10", -1, "2025-12-01"],
  ["2024-02-29", 12, "2025-02-01"],
];

const zone = process.env.TZ;
afterAll(() => void (process.env.TZ = zone));

describe.each(["Europe/Berlin", "America/New_York"])("in %s", (tz) => {
  beforeAll(() => void (process.env.TZ = tz));

  it("runs in a zone whose clocks change", () => {
    const march = tz === "Europe/Berlin" ? 29 : 8;
    expect(new Date(2026, 2, march + 1).getTime() - new Date(2026, 2, march).getTime()).toBe(23 * HOUR);
  });

  it.each(ADD)("addDays(%s, %i) is %s", (day, n, want) => {
    expect(db.addDays(day, n)).toBe(want);
    expect(ins.addDays(day, n)).toBe(want);
  });

  it.each(BETWEEN)("from %s to %s is %i days", (from, to, want) => {
    expect(db.daysBetween(from, to)).toBe(want);
    expect(ins.dayNumber(to) - ins.dayNumber(from)).toBe(want);
    expect(daysUntil(to, from)).toBe(want);
  });

  it.each(WEEKDAY)("%s is weekday %i", (day, want) => {
    expect(db.weekday(day)).toBe(want);
    expect(isWeekend(ins.dayNumber(day))).toBe(want >= 5);
  });

  it.each(ADD_MONTHS)("addMonths(%s, %i) is %s", (day, n, want) => {
    expect(db.addMonths(day, n)).toBe(want);
  });

  it("counts days since 1970 both ways", () => {
    expect(ins.dayNumber("1970-01-01")).toBe(0);
    expect(ins.dayNumber("1969-12-31")).toBe(-1);
    expect(ins.dayOf(-1)).toBe("1969-12-31");
    expect(ins.dayOf(ins.dayNumber("2024-02-29"))).toBe("2024-02-29");
  });

  it("cuts a scale into months at month ends, leap day included", () => {
    const start = ins.dayNumber("2024-02-26");
    const months = monthsOf({ start, end: start + 13, zoom: "weeks", dayW: 24 });
    expect(months).toEqual([
      { from: start, days: 4, month: "2024-02" },
      { from: start + 4, days: 10, month: "2024-03" },
    ]);
  });

  it("finds the day a moment falls on in the person's own zone", () => {
    expect(ins.dayOfMs(new Date(2026, 2, 29, 0, 30).getTime())).toBe("2026-03-29");
    expect(ins.dayOfMs(new Date(2026, 10, 15, 23, 59).getTime())).toBe("2026-11-15");
    expect(today(new Date(2026, 10, 15, 23, 59))).toBe("2026-11-15");
    expect(today(new Date(2026, 2, 8, 0, 0))).toBe("2026-03-08");
  });
});
