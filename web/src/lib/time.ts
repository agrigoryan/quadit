// Times and days as a person reads them. Times are Unix milliseconds, shown in
// the person's own time zone; dates are "YYYY-MM-DD" calendar days, the same
// day everywhere (their arithmetic is in lib/days.ts). Every date format the
// app shows is built here, once.

import { t } from "@/lib/i18n";
import { daysBetween, utcDayOf, utcMidnight } from "@/lib/days";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A format for moments, in the person's own time zone. */
const local = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, options);
/** A format for calendar days: a day is written as its UTC midnight read in UTC, so it is the day it names wherever the person is. */
const utc = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" });

const moment = {
  dayAndMonth: local({ month: "short", day: "numeric" }),
  dayMonthAndYear: local({ month: "short", day: "numeric", year: "numeric" }),
  fullDate: local({ dateStyle: "medium" }),
  exact: local({ dateStyle: "medium", timeStyle: "short" }),
  clock: local({ hour: "numeric", minute: "2-digit" }),
  toTheSecond: local({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }),
};

const calendar = {
  dayAndMonth: utc({ month: "short", day: "numeric" }),
  dayMonthAndYear: utc({ month: "short", day: "numeric", year: "numeric" }),
  monthAndYear: utc({ month: "long", year: "numeric" }),
  shortMonthAndYear: utc({ month: "short", year: "numeric" }),
  shortMonthAndTwoDigitYear: utc({ month: "short", year: "2-digit" }),
  shortWeekday: utc({ weekday: "short" }),
  longWeekday: utc({ weekday: "long" }),
};

// ---- moments ----

/** "just now", "5m", "3h", "2d", then a date. For lists and timelines. */
export function ago(ms: number, now: number = Date.now()): string {
  const d = now - ms;
  if (d < MIN) return t("time.now");
  if (d < HOUR) return t("time.minutes", { n: Math.floor(d / MIN) });
  if (d < DAY) return t("time.hours", { n: Math.floor(d / HOUR) });
  if (d < 7 * DAY) return t("time.days", { n: Math.floor(d / DAY) });
  return new Date(ms).getFullYear() === new Date(now).getFullYear()
    ? moment.dayAndMonth.format(ms)
    : moment.dayMonthAndYear.format(ms);
}

/** The exact moment, for a tooltip: "Nov 15, 2026, 3:30 PM". */
export const exact = (ms: number) => moment.exact.format(ms);

/** The clock time: "3:30 PM". */
export const timeOfDay = (ms: number) => moment.clock.format(ms);

/** The day and month of a moment: "Nov 15". */
export const dayAndMonth = (ms: number) => moment.dayAndMonth.format(ms);

/** The date of a moment, with the year: "Nov 15, 2026". */
export const fullDate = (ms: number) => moment.fullDate.format(ms);

/** The day and the time to the second, for a log: "Nov 15, 3:30:05 PM". */
export const toTheSecond = (ms: number) => moment.toTheSecond.format(ms);

/** The server writes moments as "2026-11-14 20:57" in UTC; this is that moment in milliseconds, or 0. */
export function parseWhen(when: string | undefined): number {
  if (!when) return 0;
  const ms = Date.parse(`${when.replace(" ", "T")}:00Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

// ---- the day it is ----

/**
 * Today as the server counts days (UTC), as YYYY-MM-DD. Cycles start and end
 * on the server's days, so "the current cycle" is the same one for everybody
 * and for the API, whatever time zone a browser is in.
 */
export const serverDay = (now: Date = new Date()): string => utcDayOf(now.getTime());

/** The calendar day a moment falls on in the person's own time zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today as YYYY-MM-DD in the person's own time zone. */
export const today = (now: Date = new Date()): string => localDay(now.getTime());

/** The moment a calendar day begins in the person's own time zone. */
export function localMidnight(day: string): number {
  const d = new Date(utcMidnight(day));
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

/** Whole days from today to a day; negative when it has passed. */
export const daysUntil = (day: string, from: string = today()): number => daysBetween(from, day);

// ---- calendar days ----

/** A calendar day: "Dec 1", or "Dec 1, 2025" when it is not this year. */
export function formatDay(day: string): string {
  const at = utcMidnight(day);
  return new Date(at).getUTCFullYear() === new Date().getFullYear()
    ? calendar.dayAndMonth.format(at)
    : calendar.dayMonthAndYear.format(at);
}

/** The month a day is in: "November 2026". */
export const monthAndYear = (day: string) => calendar.monthAndYear.format(utcMidnight(day));

/** "Nov 2026". */
export const shortMonthAndYear = (day: string) => calendar.shortMonthAndYear.format(utcMidnight(day));

/** "Nov 26". */
export const shortMonthAndTwoDigitYear = (day: string) => calendar.shortMonthAndTwoDigitYear.format(utcMidnight(day));

/** The weekday of a day in the person's language: "Mon", or "Monday" when long. */
export const weekdayName = (day: string, width: "short" | "long" = "short") =>
  (width === "long" ? calendar.longWeekday : calendar.shortWeekday).format(utcMidnight(day));

/** How a due date reads next to a task: "Today", "Tomorrow", "3d late", "Dec 1". */
export function dueLabel(day: string): { text: string; tone: "late" | "soon" | "later" } {
  const n = daysUntil(day);
  if (n < 0) return { text: t("due.late", { n: -n }), tone: "late" };
  if (n === 0) return { text: t("due.today"), tone: "soon" };
  if (n === 1) return { text: t("due.tomorrow"), tone: "soon" };
  return { text: formatDay(day), tone: n <= 3 ? "soon" : "later" };
}

/** A length of time in minutes: "45m", "3h 05m", "2d 4h". */
export function lengthOfMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  if (m < 60) return t("time.length.m", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("time.length.hm", { h, m: String(m % 60).padStart(2, "0") });
  return t("time.length.dh", { d: Math.floor(h / 24), h: h % 24 });
}

/** A length of time in hours, as the server counts waits (3.4): "3h 24m", "2d 4h". */
export const lengthOfHours = (h: number) => lengthOfMinutes(h * 60);

/** Video time as m:ss. */
export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
