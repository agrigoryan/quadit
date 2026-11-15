// The timeline's scale: where weeks, weekends and months fall (insights/timeline/scale.ts).

import { describe, expect, it } from "vitest";
import { dayFromNumber, dayNumber, weekday } from "@/lib/days";
import { dateOf, frame, isWeekend, monthsOf } from "@/insights/timeline/scale";

describe("scale", () => {
  it("cuts the days shown into months at month ends, leap day included", () => {
    const start = dayNumber("2024-02-26");
    expect(monthsOf({ start, end: start + 40, zoom: "weeks", dayW: 24 })).toEqual([
      { from: start, days: 4, month: "2024-02" },
      { from: start + 4, days: 31, month: "2024-03" },
      { from: start + 35, days: 6, month: "2024-04" },
    ]);
  });

  it("starts on a Monday and ends on a Sunday, before 1970 too", () => {
    for (const day of ["2026-11-15", "2026-11-16", "1969-12-31"]) {
      const { start, end } = frame(null, dayNumber(day));
      expect(weekday(dayFromNumber(start))).toBe(0);
      expect(weekday(dayFromNumber(end))).toBe(6);
    }
  });

  it("knows weekends and the day of the month", () => {
    expect(isWeekend(dayNumber("2026-11-14"))).toBe(true);
    expect(isWeekend(dayNumber("2026-11-15"))).toBe(true);
    expect(isWeekend(dayNumber("2026-11-16"))).toBe(false);
    expect(isWeekend(dayNumber("1969-12-28"))).toBe(true);
    expect(dateOf(dayNumber("2026-11-05"))).toBe(5);
  });
});
