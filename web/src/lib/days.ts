// Calendar days: "YYYY-MM-DD" strings with no time zone, the way due dates,
// cycles, epics and date properties are stored. All arithmetic here counts in
// UTC, where every day is 24 hours long, so the answer is the same in every
// time zone. What a person reads ("Today", "Dec 1") is in lib/time.ts.

const DAY_MS = 86_400_000;

/** A string shaped like a calendar day. */
export const isDay = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** The moment a day begins in UTC, in milliseconds. */
export const utcMidnight = (day: string) =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

/** The day a moment falls on in UTC: the day as the server counts it. */
export const utcDayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A day as a count of days since 1 January 1970 (negative before it), so days can be subtracted and drawn. */
export const dayNumber = (day: string) => Math.round(utcMidnight(day) / DAY_MS);

/** The day a day number stands for. */
export const dayFromNumber = (n: number) => utcDayOf(n * DAY_MS);

export const addDays = (day: string, n: number) => dayFromNumber(dayNumber(day) + n);

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

/** `count` days in a row, starting with `first`. */
export const daysFrom = (first: string, count: number) => Array.from({ length: count }, (_, i) => addDays(first, i));

/** 0 for Monday … 6 for Sunday. Day number 0, 1 January 1970, was a Thursday. */
export const weekday = (day: string) => (((dayNumber(day) + 3) % 7) + 7) % 7;

/** The Monday on or before a day. */
export const startOfWeek = (day: string) => addDays(day, -weekday(day));

/** The day of the month, 1 to 31. */
export const dayOfMonth = (day: string) => Number(day.slice(8, 10));

/** The month a day is in, as "YYYY-MM". */
export const monthOf = (day: string) => day.slice(0, 7);

export const sameMonth = (a: string, b: string) => monthOf(a) === monthOf(b);

/** The first day of the month a day is in. */
export const monthStart = (day: string) => `${monthOf(day)}-01`;

/** The first day of the month `n` months after (or before) the one a day is in. */
export function addMonths(day: string, n: number): string {
  const first = new Date(utcMidnight(day));
  return utcDayOf(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + n, 1));
}

/** The last day of the month a day is in. */
export const monthEnd = (day: string) => addDays(addMonths(day, 1), -1);

/** The same day of the month `n` months later (or earlier), or that month's last day where it is shorter: 31 January and a month is 28 February. */
export function shiftMonths(day: string, n: number): string {
  const first = addMonths(day, n);
  return addDays(first, Math.min(dayOfMonth(day), dayOfMonth(monthEnd(first))) - 1);
}

/** The year a day is in. */
export const yearOf = (day: string) => Number(day.slice(0, 4));

/** The day of a year, a month (1 to 12) and a day of the month; undefined where there is no such day (30 February). */
export function dayFromParts(year: number, month: number, date: number): string | undefined {
  if (![year, month, date].every(Number.isInteger) || year < 1000 || year > 9999) return undefined;
  const day = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
  return isDay(day) && dayFromNumber(dayNumber(day)) === day ? day : undefined;
}
