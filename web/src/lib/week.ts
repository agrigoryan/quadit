// The week as the person's language has it: the day it starts on and the
// days of its weekend (Monday and Saturday-Sunday in Britain, Sunday and
// Saturday-Sunday in the United States, Sunday and Friday-Saturday in
// Israel), and the working days a date picker offers from them: the end of
// this week, the start of the next. Days are counted as lib/days.ts counts
// them, 0 for Monday to 6 for Sunday.

import { addDays, daysFrom, weekday } from "@/lib/days";

export interface Week {
  /** The day a week starts on: 0 for Monday … 6 for Sunday. */
  first: number;
  /** The days off, counted the same way. */
  weekend: number[];
}

/** Where the browser cannot say: Monday first, Saturday and Sunday off. */
const MONDAY_FIRST: Week = { first: 0, weekend: [5, 6] };

/** What Intl.Locale tells of a week, its days counted 1 for Monday … 7 for Sunday. */
interface WeekInfo {
  firstDay: number;
  weekend: number[];
}

/**
 * The week of a language ("en-GB"), from the browser: Intl.Locale's
 * getWeekInfo(), or its older weekInfo, where it has either.
 */
export function weekFor(language: string): Week {
  let info: WeekInfo | undefined;
  try {
    // Not yet in TypeScript's library: the method in today's browsers, the property in older ones.
    const locale = new Intl.Locale(language) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };
    info = locale.getWeekInfo?.() ?? locale.weekInfo;
  } catch {
    return MONDAY_FIRST; // a language the browser cannot read
  }
  if (!info) return MONDAY_FIRST;
  return { first: info.firstDay - 1, weekend: info.weekend.map((day) => day - 1) };
}

/** The person's week: that of the language the app's dates are written in. */
export const personWeek: Week = weekFor(Intl.DateTimeFormat().resolvedOptions().locale);

/** The first day of the week a day is in. */
export const weekStart = (day: string, week: Week) => addDays(day, -((weekday(day) - week.first + 7) % 7));

export const isWeekend = (day: string, week: Week) => week.weekend.includes(weekday(day));

/** The working days of the week that starts on `first`; every day, for a week said to be all weekend. */
function workingDays(first: string, week: Week): string[] {
  const days = daysFrom(first, 7);
  const working = days.filter((day) => !isWeekend(day, week));
  return working.length > 0 ? working : days;
}

/** The last working day of the week, on or after a day: this week's, or next week's once it has passed. */
export function endOfWeek(day: string, week: Week): string {
  const start = weekStart(day, week);
  const last = workingDays(start, week).at(-1) ?? day;
  return last >= day ? last : (workingDays(addDays(start, 7), week).at(-1) ?? day);
}

/** The first working day of the week after the one a day is in. */
export const nextWeek = (day: string, week: Week) =>
  workingDays(addDays(weekStart(day, week), 7), week)[0] ?? addDays(weekStart(day, week), 7);
