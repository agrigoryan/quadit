// Reading the day a person types (lib/day-words.ts). Today is Thursday
// 26 November 2026 throughout, in a week of Monday to Sunday with Saturday
// and Sunday off, unless a test says otherwise.

import { describe, expect, it } from "vitest";
import { readDay } from "@/lib/day-words";
import type { Week } from "@/lib/week";

const MONDAY: Week = { first: 0, weekend: [5, 6] };
const SUNDAY_TO_THURSDAY: Week = { first: 6, weekend: [4, 5] };
const at = { today: "2026-11-26", week: MONDAY };

const read = (text: string) => readDay(text, at);

const READS: [string, string][] = [
  // Words for days near today.
  ["today", "2026-11-26"],
  ["tomorrow", "2026-11-27"],
  ["tmrw", "2026-11-27"],
  ["yesterday", "2026-11-25"],
  ["Today", "2026-11-26"],
  ["  TOMORROW  ", "2026-11-27"],
  // A weekday is the next one to come; "next" the one after; "this" may be today.
  ["fri", "2026-11-27"],
  ["friday", "2026-11-27"],
  ["Friday.", "2026-11-27"],
  ["mon", "2026-11-30"],
  ["monday", "2026-11-30"],
  ["tue", "2026-12-01"],
  ["tues", "2026-12-01"],
  ["wed", "2026-12-02"],
  ["thu", "2026-12-03"],
  ["thurs", "2026-12-03"],
  ["thursday", "2026-12-03"],
  ["sat", "2026-11-28"],
  ["sun", "2026-11-29"],
  ["next fri", "2026-12-04"],
  ["next friday", "2026-12-04"],
  ["next mon", "2026-12-07"],
  // On the day itself, "next" is a week on.
  ["next thu", "2026-12-03"],
  ["this thu", "2026-11-26"],
  ["this fri", "2026-11-27"],
  ["this wed", "2026-12-02"],
  // Weeks and months.
  ["next week", "2026-11-30"],
  ["next month", "2026-12-01"],
  ["end of week", "2026-11-27"],
  ["end of the week", "2026-11-27"],
  ["end of this week", "2026-11-27"],
  ["eow", "2026-11-27"],
  ["end of next week", "2026-12-04"],
  ["end of month", "2026-11-30"],
  ["end of the month", "2026-11-30"],
  ["end of this month", "2026-11-30"],
  ["eom", "2026-11-30"],
  ["end of next month", "2026-12-31"],
  // A count of days, weeks, months or years from today.
  ["in 3 days", "2026-11-29"],
  ["in 1 day", "2026-11-27"],
  ["in a day", "2026-11-27"],
  ["in 2 weeks", "2026-12-10"],
  ["in two weeks", "2026-12-10"],
  ["in a week", "2026-12-03"],
  ["in 1 month", "2026-12-26"],
  ["in a month", "2026-12-26"],
  ["in 3 months", "2027-02-26"],
  ["in 1 year", "2027-11-26"],
  ["in ten days", "2026-12-06"],
  ["3 days", "2026-11-29"],
  ["3d", "2026-11-29"],
  ["3 d", "2026-11-29"],
  ["in 3d", "2026-11-29"],
  ["2w", "2026-12-10"],
  ["1mo", "2026-12-26"],
  ["1y", "2027-11-26"],
  ["+3", "2026-11-29"],
  ["-1", "2026-11-25"],
  ["+0", "2026-11-26"],
  ["+2w", "2026-12-10"],
  ["-1w", "2026-11-19"],
  ["3 days ago", "2026-11-23"],
  ["a week ago", "2026-11-19"],
  ["2 months ago", "2026-09-26"],
  // A day of a month: the next one to come when no year is given.
  ["dec 5", "2026-12-05"],
  ["Dec 5", "2026-12-05"],
  ["december 5", "2026-12-05"],
  ["dec 5th", "2026-12-05"],
  ["5 dec", "2026-12-05"],
  ["5th dec", "2026-12-05"],
  ["5th of december", "2026-12-05"],
  ["the 5th of december", "2026-12-05"],
  ["nov 26", "2026-11-26"],
  ["nov 25", "2027-11-25"],
  ["jan 3", "2027-01-03"],
  ["sept 1", "2027-09-01"],
  ["sep 1", "2027-09-01"],
  ["december 5 2027", "2027-12-05"],
  ["december 5, 2027", "2027-12-05"],
  ["dec 5th, 2027", "2027-12-05"],
  ["5 dec 2027", "2027-12-05"],
  ["5 december 2025", "2025-12-05"],
  ["feb 29 2028", "2028-02-29"],
  // A day of this month, or of the next once it has passed.
  ["28", "2026-11-28"],
  ["28th", "2026-11-28"],
  ["the 28th", "2026-11-28"],
  ["26", "2026-11-26"],
  ["5", "2026-12-05"],
  ["1st", "2026-12-01"],
  ["31", "2026-12-31"],
  // The day itself.
  ["2027-12-05", "2027-12-05"],
  ["2027-1-5", "2027-01-05"],
  ["2024-02-29", "2024-02-29"],
];

const UNREAD = [
  "",
  "   ",
  "soon",
  "blah",
  "next",
  "in",
  "in days",
  "in 3 ago",
  "fr",
  "next tomorrow",
  "decem 5 2027 extra",
  "feb 30",
  "feb 29 2027",
  "2027-02-30",
  "2027-13-01",
  "27-12-05",
  "32",
  "0",
  "dec 0",
  "dec 32",
  "ju 5",
  "5 5",
  "in 3 minutes",
  "+",
  "3dd",
  "12/5",
];

describe("readDay", () => {
  it.each(READS)("reads %j as %s", (text, want) => expect(read(text)).toBe(want));

  it.each(UNREAD)("cannot read %j", (text) => expect(read(text)).toBeUndefined());

  it("goes to the end of the next month that has the day, a month on from the 31st", () => {
    expect(readDay("in 1 month", { ...at, today: "2027-01-31" })).toBe("2027-02-28");
  });

  it("reads 31 as the next month that has a 31st", () => {
    expect(readDay("31", { ...at, today: "2027-04-05" })).toBe("2027-05-31");
  });

  it("reads next and a weekday on that weekday as a week on, as its bare name is", () => {
    const friday = { ...at, today: "2026-11-27" };
    expect(readDay("fri", friday)).toBe("2026-12-04");
    expect(readDay("next fri", friday)).toBe("2026-12-04");
    expect(readDay("next sat", friday)).toBe("2026-12-05");
  });

  it("reads 29 February with no year as the next one to come", () => {
    expect(readDay("feb 29", at)).toBe("2028-02-29");
  });

  it("goes by the week's working days for the end of the week and the next week", () => {
    const israel = { today: "2026-11-26", week: SUNDAY_TO_THURSDAY };
    expect(readDay("end of week", israel)).toBe("2026-11-26");
    expect(readDay("next week", israel)).toBe("2026-11-29");
    expect(readDay("end of week", { ...israel, today: "2026-11-27" })).toBe("2026-12-03");
  });

  it("reads the end of this week on a weekend as the Friday to come, and the end of next week as the one after", () => {
    const saturday = { ...at, today: "2026-11-28" };
    expect(readDay("end of this week", saturday)).toBe("2026-12-04");
    expect(readDay("end of next week", saturday)).toBe("2026-12-11");
  });

  it("takes next week from a weekend to the week after it", () => {
    expect(readDay("next week", { ...at, today: "2026-11-29" })).toBe("2026-11-30");
    expect(readDay("end of week", { ...at, today: "2026-11-28" })).toBe("2026-12-04");
  });

  it("reads across the end of a year", () => {
    const eve = { ...at, today: "2026-12-31" };
    expect(readDay("tomorrow", eve)).toBe("2027-01-01");
    expect(readDay("next month", eve)).toBe("2027-01-01");
    expect(readDay("jan 1", eve)).toBe("2027-01-01");
    expect(readDay("dec 31", eve)).toBe("2026-12-31");
    expect(readDay("dec 30", eve)).toBe("2027-12-30");
  });
});
