// Calendar days read as the day they name west of UTC too (lib/time.ts). A day
// is kept as its UTC midnight; read in Los Angeles' time, that moment is the
// evening before, so a format that forgot to read it in UTC would show the
// day, month or year before.

import { afterAll, describe, expect, it, vi } from "vitest";
import { formatDay, monthAndYear, shortMonthAndTwoDigitYear, shortMonthAndYear, weekdayName } from "@/lib/time";

// The zone and the language are fixed before lib/time.ts builds its formats.
const before = vi.hoisted(() => {
  const was = { zone: process.env.TZ, format: Intl.DateTimeFormat };
  process.env.TZ = "America/Los_Angeles";
  class English extends Intl.DateTimeFormat {
    constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      super(locales ?? "en-US", options);
    }
  }
  Intl.DateTimeFormat = English as typeof Intl.DateTimeFormat;
  return was;
});

afterAll(() => {
  process.env.TZ = before.zone;
  Intl.DateTimeFormat = before.format;
});

describe("calendar days in Los Angeles", () => {
  it("read as the day, month and year they name", () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 15, 12) });
    expect(formatDay("2026-11-01")).toBe("Nov 1");
    expect(formatDay("2027-01-01")).toBe("Jan 1, 2027");
    expect(monthAndYear("2027-01-01")).toBe("January 2027");
    expect(shortMonthAndYear("2027-01-01")).toBe("Jan 2027");
    expect(shortMonthAndTwoDigitYear("2027-01-01")).toBe("Jan 27");
    expect(weekdayName("2026-11-16")).toBe("Mon");
    expect(weekdayName("2026-11-16", "long")).toBe("Monday");
    vi.useRealTimers();
  });
});
