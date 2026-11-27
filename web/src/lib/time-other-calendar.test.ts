// Calendar days are written in the Gregorian calendar (lib/time.ts) where the
// language's own calendar is another: a day is an ISO day, and a month grid
// counts it by its Gregorian number, so its month, its name and its number
// must agree. Here the language is English with the Persian calendar.

import { afterAll, describe, expect, it, vi } from "vitest";
import { formatDay, fullDay, monthAndYear, weekdayAndDay } from "@/lib/time";

// The language is fixed before lib/time.ts builds its formats.
const before = vi.hoisted(() => {
  const was = { format: Intl.DateTimeFormat };
  const persian = (locales?: string | string[], options?: Intl.DateTimeFormatOptions) =>
    new was.format(locales ?? "en-US-u-ca-persian", options);
  Intl.DateTimeFormat = new Proxy(was.format, {
    construct: (_, [locales, options]) => persian(locales, options),
    apply: (_, __, [locales, options]) => persian(locales, options),
  });
  return was;
});

afterAll(() => {
  Intl.DateTimeFormat = before.format;
});

describe("calendar days in a language whose calendar is not Gregorian", () => {
  it("are written as the Gregorian days they are", () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 15, 12), toFake: ["Date"] });
    expect(monthAndYear("2026-06-26")).toBe("June 2026");
    expect(fullDay("2026-06-26")).toBe("Friday, June 26, 2026");
    expect(formatDay("2026-06-26")).toBe("Jun 26");
    expect(weekdayAndDay("2026-06-26")).toBe("Fri, Jun 26");
    vi.useRealTimers();
  });
});
