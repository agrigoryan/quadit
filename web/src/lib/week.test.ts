// The week as a language has it (lib/week.ts): the day it starts on, its
// weekend, and the working days a date picker offers from them.

import { describe, expect, it } from "vitest";
import { endOfWeek, isWeekend, nextWeek, type Week, weekFor, weekStart } from "@/lib/week";

const MONDAY: Week = { first: 0, weekend: [5, 6] };
const SUNDAY: Week = { first: 6, weekend: [5, 6] };
// Sunday to Thursday at work, Friday and Saturday off.
const SUNDAY_TO_THURSDAY: Week = { first: 6, weekend: [4, 5] };

// 2026-11-26 is a Thursday.
describe("weekFor", () => {
  it("reads the browser's week for a language", () => {
    expect(weekFor("en-GB")).toEqual(MONDAY);
    expect(weekFor("en-US")).toEqual(SUNDAY);
    expect(weekFor("he-IL")).toEqual(SUNDAY_TO_THURSDAY);
  });

  it("is Monday first, Saturday and Sunday off, for a language it cannot read", () => {
    expect(weekFor("not a language")).toEqual(MONDAY);
  });
});

describe("weekStart", () => {
  it("is the week's first day on or before a day", () => {
    expect(weekStart("2026-11-26", MONDAY)).toBe("2026-11-23");
    expect(weekStart("2026-11-23", MONDAY)).toBe("2026-11-23");
    expect(weekStart("2026-11-29", MONDAY)).toBe("2026-11-23");
    expect(weekStart("2026-11-26", SUNDAY)).toBe("2026-11-22");
    expect(weekStart("2026-11-22", SUNDAY)).toBe("2026-11-22");
    expect(weekStart("2026-11-28", SUNDAY)).toBe("2026-11-22");
  });
});

describe("isWeekend", () => {
  it("is the language's days off", () => {
    expect(isWeekend("2026-11-28", MONDAY)).toBe(true);
    expect(isWeekend("2026-11-29", MONDAY)).toBe(true);
    expect(isWeekend("2026-11-27", MONDAY)).toBe(false);
    expect(isWeekend("2026-11-27", SUNDAY_TO_THURSDAY)).toBe(true);
    expect(isWeekend("2026-11-29", SUNDAY_TO_THURSDAY)).toBe(false);
  });
});

describe("endOfWeek", () => {
  it("is the week's last working day, still to come", () => {
    expect(endOfWeek("2026-11-26", MONDAY)).toBe("2026-11-27");
    expect(endOfWeek("2026-11-23", MONDAY)).toBe("2026-11-27");
    expect(endOfWeek("2026-11-27", MONDAY)).toBe("2026-11-27");
    expect(endOfWeek("2026-11-26", SUNDAY)).toBe("2026-11-27");
    expect(endOfWeek("2026-11-26", SUNDAY_TO_THURSDAY)).toBe("2026-11-26");
  });

  it("is next week's, once this week's has passed", () => {
    expect(endOfWeek("2026-11-28", MONDAY)).toBe("2026-12-04");
    expect(endOfWeek("2026-11-29", MONDAY)).toBe("2026-12-04");
    expect(endOfWeek("2026-11-28", SUNDAY)).toBe("2026-12-04");
    expect(endOfWeek("2026-11-27", SUNDAY_TO_THURSDAY)).toBe("2026-12-03");
  });
});

describe("nextWeek", () => {
  it("is the first working day of the week after", () => {
    expect(nextWeek("2026-11-26", MONDAY)).toBe("2026-11-30");
    expect(nextWeek("2026-11-29", MONDAY)).toBe("2026-11-30");
    expect(nextWeek("2026-11-30", MONDAY)).toBe("2026-12-07");
    // A week of Sunday to Saturday whose Sunday is off still goes back to work on Monday.
    expect(nextWeek("2026-11-26", SUNDAY)).toBe("2026-11-30");
    expect(nextWeek("2026-11-29", SUNDAY)).toBe("2026-12-07");
    expect(nextWeek("2026-11-26", SUNDAY_TO_THURSDAY)).toBe("2026-11-29");
  });
});
