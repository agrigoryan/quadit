// Calendar days as "YYYY-MM-DD" strings, the way date properties store them.

const DAY = 86_400_000;

export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A day as a moment at UTC midnight, for arithmetic that no clock change can upset. */
const utc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

const fromUTC = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day: string, n: number) => fromUTC(utc(day) + n * DAY);

/** Whole days from `a` to `b`; negative when b is earlier. */
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY);

/** 0 for Monday … 6 for Sunday. */
export const weekday = (day: string) => (new Date(utc(day)).getUTCDay() + 6) % 7;

export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

export function addMonths(day: string, n: number): string {
  const d = new Date(utc(monthStart(day)));
  return fromUTC(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const weekdayShort = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });

export const monthName = (day: string) => monthYear.format(utc(day));
export const monthShortName = (day: string) => monthShort.format(utc(day));

/** "Mon" … "Sun" in the person's language. 2024-01-01 was a Monday. */
export const WEEKDAYS = Array.from({ length: 7 }, (_, i) => weekdayShort.format(Date.UTC(2024, 0, 1 + i)));
