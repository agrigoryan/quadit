// Times are Unix milliseconds; dates are "YYYY-MM-DD" strings with no time
// zone (a due date is a calendar day, the same day everywhere).

import { t } from "@/lib/i18n";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "just now", "5m", "3h", "2d", then a date. For lists and timelines. */
export function ago(ms: number, now: number = Date.now()): string {
  const d = now - ms;
  if (d < MIN) return t("time.now");
  if (d < HOUR) return t("time.minutes", { n: Math.floor(d / MIN) });
  if (d < DAY) return t("time.hours", { n: Math.floor(d / HOUR) });
  if (d < 7 * DAY) return t("time.days", { n: Math.floor(d / DAY) });
  return new Date(ms).getFullYear() === new Date(now).getFullYear() ? shortDate.format(ms) : longDate.format(ms);
}

/** The exact moment, for a tooltip. */
export const exact = (ms: number) => fullTime.format(ms);
export const timeOfDay = (ms: number) => clock.format(ms);

/**
 * Today as the server counts days (UTC), as YYYY-MM-DD. Cycles start and end
 * on the server's days, so "the current cycle" is the same one for everybody
 * and for the API, whatever time zone a browser is in.
 */
export const serverDay = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** Today as YYYY-MM-DD in the person's own time zone. */
export function today(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** A calendar day for display: "Dec 1", or with the year when it is not this year. */
export function formatDay(day: string): string {
  const date = parseDay(day);
  return date.getFullYear() === new Date().getFullYear() ? shortDate.format(date) : longDate.format(date);
}

/** Whole days from today to a day; negative when it has passed. */
export function daysUntil(day: string, from: string = today()): number {
  return Math.round((parseDay(day).getTime() - parseDay(from).getTime()) / DAY);
}

/** How a due date reads next to a task: "Today", "Tomorrow", "3d late", "Dec 1". */
export function dueLabel(day: string): { text: string; tone: "late" | "soon" | "later" } {
  const n = daysUntil(day);
  if (n < 0) return { text: t("due.late", { n: -n }), tone: "late" };
  if (n === 0) return { text: t("due.today"), tone: "soon" };
  if (n === 1) return { text: t("due.tomorrow"), tone: "soon" };
  return { text: formatDay(day), tone: n <= 3 ? "soon" : "later" };
}

/** Video time as m:ss. */
export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
