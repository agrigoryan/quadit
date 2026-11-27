// Calendar-day arithmetic (lib/days.ts). The tables were first run against the
// three copies this file replaced (docs/db/dates.ts, insights/lib/format.ts and
// the local-time arithmetic in lib/time.ts), which all agreed on them; they run
// in two zones whose clocks change, because UTC arithmetic must not care.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayFromNumber,
  dayFromParts,
  dayNumber,
  dayOfMonth,
  daysBetween,
  daysFrom,
  isDay,
  monthEnd,
  monthStart,
  sameMonth,
  shiftMonths,
  startOfWeek,
  weekday,
  yearOf,
} from "@/lib/days";

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

const SHIFT_MONTHS: [string, number, string][] = [
  ["2026-01-31", 1, "2026-02-28"],
  ["2024-01-31", 1, "2024-02-29"],
  ["2026-03-31", -1, "2026-02-28"],
  ["2026-11-26", 1, "2026-12-26"],
  ["2026-12-15", 1, "2027-01-15"],
  ["2026-11-30", 3, "2027-02-28"],
  ["2024-02-29", 12, "2025-02-28"],
  ["2026-05-31", 0, "2026-05-31"],
];

const zone = process.env.TZ;
afterAll(() => void (process.env.TZ = zone));

describe.each(["Europe/Berlin", "America/New_York"])("in %s", (tz) => {
  beforeAll(() => void (process.env.TZ = tz));

  it("runs in a zone whose clocks change", () => {
    const march = tz === "Europe/Berlin" ? 29 : 8;
    expect(new Date(2026, 2, march + 1).getTime() - new Date(2026, 2, march).getTime()).toBe(23 * HOUR);
  });

  it.each(ADD)("addDays(%s, %i) is %s", (day, n, want) => expect(addDays(day, n)).toBe(want));

  it.each(BETWEEN)("from %s to %s is %i days", (from, to, want) => expect(daysBetween(from, to)).toBe(want));

  it.each(WEEKDAY)("%s is weekday %i", (day, want) => {
    expect(weekday(day)).toBe(want);
    expect(startOfWeek(day)).toBe(addDays(day, -want));
    expect(weekday(startOfWeek(day))).toBe(0);
  });

  it.each(ADD_MONTHS)("addMonths(%s, %i) is %s", (day, n, want) => expect(addMonths(day, n)).toBe(want));

  it.each(SHIFT_MONTHS)("shiftMonths(%s, %i) is %s", (day, n, want) => expect(shiftMonths(day, n)).toBe(want));

  it("gives a month's last day", () => {
    expect(monthEnd("2026-11-26")).toBe("2026-11-30");
    expect(monthEnd("2026-12-01")).toBe("2026-12-31");
    expect(monthEnd("2024-02-10")).toBe("2024-02-29");
    expect(monthEnd("2100-02-10")).toBe("2100-02-28");
  });

  it("makes a day of its parts, and none of parts that name no day", () => {
    expect(dayFromParts(2027, 12, 5)).toBe("2027-12-05");
    expect(dayFromParts(2024, 2, 29)).toBe("2024-02-29");
    expect(dayFromParts(2026, 2, 29)).toBeUndefined();
    expect(dayFromParts(2026, 13, 1)).toBeUndefined();
    expect(dayFromParts(2026, 4, 31)).toBeUndefined();
    expect(dayFromParts(2026, 0, 1)).toBeUndefined();
    expect(dayFromParts(2026, 1, 0)).toBeUndefined();
    expect(dayFromParts(2026, 1.5, 1)).toBeUndefined();
    expect(dayFromParts(99, 1, 1)).toBeUndefined();
    expect(yearOf("2027-12-05")).toBe(2027);
  });

  it("keeps a year below 100 as written, not as one of the 1900s", () => {
    expect(addDays("0099-03-15", 1)).toBe("0099-03-16");
    expect(addDays("0001-01-01", -1)).toBe("0000-12-31");
    expect(dayFromNumber(dayNumber("0099-03-15"))).toBe("0099-03-15");
  });

  it("counts days since 1970 both ways", () => {
    expect(dayNumber("1970-01-01")).toBe(0);
    expect(dayNumber("1969-12-31")).toBe(-1);
    expect(dayFromNumber(-1)).toBe("1969-12-31");
    expect(dayFromNumber(dayNumber("2024-02-29"))).toBe("2024-02-29");
  });

  it("gives runs of days, months and days of the month", () => {
    expect(daysFrom("2024-02-27", 4)).toEqual(["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"]);
    expect(daysFrom("2026-11-15", 0)).toEqual([]);
    expect(monthStart("2026-11-15")).toBe("2026-11-01");
    expect(sameMonth("2026-11-30", "2026-11-01")).toBe(true);
    expect(sameMonth("2026-11-30", "2026-12-01")).toBe(false);
    expect(sameMonth("2025-11-30", "2026-11-30")).toBe(false);
    expect(dayOfMonth("2026-11-05")).toBe(5);
    expect(dayOfMonth("2026-11-25")).toBe(25);
  });
});

describe("isDay", () => {
  it("takes YYYY-MM-DD and nothing else", () => {
    expect(isDay("2026-11-15")).toBe(true);
    expect(isDay("2026-1-5")).toBe(false);
    expect(isDay("2026-11-15T10:00")).toBe(false);
    expect(isDay(20261115)).toBe(false);
    expect(isDay(undefined)).toBe(false);
  });
});

// Samoa moved across the date line at the end of 2011 and skipped 30 December.
// lib/time.ts used to count days between local midnights, which there made
// 29 to 31 December one day apart; a calendar counts two.
describe("in Pacific/Apia", () => {
  beforeAll(() => void (process.env.TZ = "Pacific/Apia"));

  it("counts a skipped local day as a calendar day", () => {
    expect(daysBetween("2011-12-29", "2011-12-31")).toBe(2);
    expect(addDays("2011-12-29", 1)).toBe("2011-12-30");
  });
});
