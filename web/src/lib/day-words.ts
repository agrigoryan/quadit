// Reading the day a person types into a date picker: "tomorrow", "fri",
// "next week", "in 3 days", "dec 5", "2027-12-05", "+3". The words are
// English, like the app; they are a small grammar rather than strings to
// show, so they live here and not in the dictionary: another language would
// need its own order of words and its own forms of "next", not a
// translation of these.
//
// What each means:
//   today, tomorrow (tmr, tmrw), yesterday
//   a weekday, whole or from its first three letters: the next one to come,
//     never today; "this fri" may be today; "next fri" is the one after,
//     except on a Friday, where both are a week on
//   next week: the first working day of next week; next month: its first day
//   end of (this) week (eow): the week's last working day, or on a weekend
//     the one to come; end of next week: a week after that;
//     end of (this) month (eom), end of next month: the month's last day
//   in 3 days, 3 days, 3d, +3; -1, 2 weeks ago: counted from today, in days,
//     weeks (w), months (mo) or years (y); a, an and one to twelve as words
//   dec 5, 5 dec, the 5th of december: the next one to come; with a year,
//     that year's
//   28, 28th: the next 28th of a month to come, today's included
//   2027-12-05: that day
// Anything else is not read.

import { addDays, addMonths, dayFromParts, monthEnd, shiftMonths, weekday, yearOf } from "@/lib/days";
import { endOfWeek, nextWeek, type Week } from "@/lib/week";

/** What a typed word is read against: today, as YYYY-MM-DD, and the week of the person's language. */
export interface ReadingContext {
  today: string;
  week: Week;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
// Counted as lib/days.ts counts them: 0 for Monday.
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const COUNTS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A month or a weekday named by its whole name or its first three letters or more ("sept"); -1 for none. */
const nameIn = (names: string[], word: string) => (word.length < 3 ? -1 : names.findIndex((n) => n.startsWith(word)));

/** A count written as digits or as a word: "3", "three", "a". */
function countOf(word: string): number | undefined {
  if (/^\d+$/.test(word)) return Number(word);
  if (word === "a" || word === "an") return 1;
  const at = COUNTS.indexOf(word);
  return at < 0 ? undefined : at + 1;
}

/** The days a unit of time moves a day by, `n` of them. */
function later(day: string, n: number, unit: string): string | undefined {
  if (/^(d|days?)$/.test(unit)) return addDays(day, n);
  if (/^(w|wks?|weeks?)$/.test(unit)) return addDays(day, 7 * n);
  if (/^(mos?|months?)$/.test(unit)) return shiftMonths(day, n);
  if (/^(y|yrs?|years?)$/.test(unit)) return shiftMonths(day, 12 * n);
  return undefined;
}

/** The first of these days, one after the other, that is a day and not before today. */
const firstToCome = (today: string, days: (string | undefined)[]) =>
  days.find((day): day is string => day !== undefined && day >= today);

/** A month and a day of it: in the year given, or the next one to come. */
function monthDay(month: number, date: number, year: string | undefined, today: string): string | undefined {
  if (year) return dayFromParts(Number(year), month, date);
  // Eight years, so that 29 February finds its next leap year.
  return firstToCome(
    today,
    Array.from({ length: 9 }, (_, i) => dayFromParts(yearOf(today) + i, month, date)),
  );
}

/** A day of a month: this month's, or the next month that has it once this one's has passed. */
function dayOfAMonth(date: number, today: string): string | undefined {
  if (date < 1 || date > 31) return undefined;
  return firstToCome(
    today,
    Array.from({ length: 13 }, (_, i) => {
      const first = addMonths(today, i);
      return dayFromParts(yearOf(first), Number(first.slice(5, 7)), date);
    }),
  );
}

/**
 * The day typed words name, as YYYY-MM-DD, read as the comment at the top
 * of this file says; undefined when they name no day this can read.
 */
export function readDay(text: string, { today, week }: ReadingContext): string | undefined {
  const words = text
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && word !== "the" && word !== "of");
  const said = words.join(" ");

  const named: Record<string, () => string> = {
    today: () => today,
    tomorrow: () => addDays(today, 1),
    tmr: () => addDays(today, 1),
    tmrw: () => addDays(today, 1),
    yesterday: () => addDays(today, -1),
    "next week": () => nextWeek(today, week),
    "next month": () => addMonths(today, 1),
    "end week": () => endOfWeek(today, week),
    "end this week": () => endOfWeek(today, week),
    eow: () => endOfWeek(today, week),
    // A week after the end of this one: on a weekend, when that is already next week's, the week after.
    "end next week": () => addDays(endOfWeek(today, week), 7),
    "end month": () => monthEnd(today),
    "end this month": () => monthEnd(today),
    eom: () => monthEnd(today),
    "end next month": () => monthEnd(addMonths(today, 1)),
  };
  const word = named[said];
  if (word) return word();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(said);
  if (iso) return dayFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const weekdayWords = /^(?:(this|next) )?([a-z]+)$/.exec(said);
  if (weekdayWords?.[2]) {
    const at = nameIn(WEEKDAYS, weekdayWords[2]);
    if (at >= 0) {
      // How many days on from today that weekday next falls, today being 0.
      const ahead = (at - weekday(today) + 7) % 7;
      if (weekdayWords[1] === "this") return addDays(today, ahead);
      // Today's own weekday comes next a week on, whether or not "next" is said.
      if (ahead === 0) return addDays(today, 7);
      return addDays(today, weekdayWords[1] === "next" ? ahead + 7 : ahead);
    }
  }

  const ordinal = "(?:st|nd|rd|th)?";
  const monthFirst = new RegExp(`^([a-z]+) (\\d{1,2})${ordinal}(?: (\\d{4}))?$`).exec(said);
  const dayFirst = new RegExp(`^(\\d{1,2})${ordinal} ([a-z]+)(?: (\\d{4}))?$`).exec(said);
  const [monthWord, dateWord, year] = monthFirst
    ? [monthFirst[1], monthFirst[2], monthFirst[3]]
    : dayFirst
      ? [dayFirst[2], dayFirst[1], dayFirst[3]]
      : [];
  // "3 days" is shaped like "3 dec": a word that names no month is read as a unit, below.
  const month = monthWord ? nameIn(MONTHS, monthWord) : -1;
  if (month >= 0) return monthDay(month + 1, Number(dateWord), year, today);

  const date = new RegExp(`^(\\d{1,2})${ordinal}$`).exec(said);
  if (date) return dayOfAMonth(Number(date[1]), today);

  // A count of units from today: "in 3 days", "3d", "+3", "2 weeks ago". Days when no unit is said.
  const count = /^(in )?([+-])? ?(\d+|[a-z]+) ?([a-z]+)?( ago)?$/.exec(said);
  if (count?.[3]) {
    const [, isIn, sign, amount, unit = "d", ago] = count;
    const n = countOf(amount);
    if (n === undefined || (isIn && (ago || sign))) return undefined;
    // A bare number with nothing around it is a day of the month, read above.
    if (!isIn && !sign && !count[4] && !ago) return undefined;
    return later(today, sign === "-" || ago ? -n : n, unit);
  }

  return undefined;
}
