// The time scale of the timeline: which days it covers, how wide a day is
// at each zoom, and where the months and weeks fall. Days are counted as
// whole numbers (days since 1970, see insights/lib/format.ts) so positions
// are plain arithmetic.

import { dayOf } from "@/insights/lib/format";

export type Zoom = "weeks" | "months";

/** Pixels per day. "Weeks" shows every day; "months" fits about a quarter on a laptop. */
export const DAY_WIDTH: Record<Zoom, number> = { weeks: 24, months: 7 };

export interface Scale {
  /** First and last day shown, both included. The first is always a Monday. */
  start: number;
  end: number;
  zoom: Zoom;
  dayW: number;
}

/** Where a day starts, in pixels from the left edge of the scale. */
export const xOf = (scale: Scale, day: number) => (day - scale.start) * scale.dayW;
export const widthOf = (scale: Scale) => (scale.end - scale.start + 1) * scale.dayW;

/** The Monday on or before a day. Day 0 (1 Jan 1970) was a Thursday. */
const monday = (day: number) => day - ((((day + 3) % 7) + 7) % 7);

/** Room left before the first date and after the last, so bars can be dragged outwards. */
const BEFORE = 21;
const AFTER = 56;

export interface Extent {
  min: number;
  max: number;
}

/** The days to show for what there is to show; today is always inside. */
export function frame(extent: Extent | null, today: number): { start: number; end: number } {
  const min = Math.min(extent?.min ?? today, today);
  const max = Math.max(extent?.max ?? today, today);
  return { start: monday(min - BEFORE), end: monday(max + AFTER) + 6 };
}

/** The same frame, widened if a date has moved close to an edge. It never shrinks while the page is open. */
export function grow(
  now: { start: number; end: number },
  extent: Extent | null,
  today: number,
): { start: number; end: number } {
  const want = frame(extent, today);
  const min = extent?.min ?? today;
  const max = extent?.max ?? today;
  const start = min < now.start + 7 ? Math.min(now.start, want.start) : now.start;
  const end = max > now.end - 14 ? Math.max(now.end, want.end) : now.end;
  return start === now.start && end === now.end ? now : { start, end };
}

export interface MonthSpan {
  /** The first day of the month that is on the scale. */
  from: number;
  days: number;
  /** "2026-11": for the label. */
  month: string;
}

/** The months the scale crosses, each cut to the part that shows. */
export function monthsOf(scale: Scale): MonthSpan[] {
  const out: MonthSpan[] = [];
  let from = scale.start;
  while (from <= scale.end) {
    const [y, m] = dayOf(from).split("-").map(Number);
    const next = Math.round(Date.UTC(y ?? 1970, m ?? 1, 1) / 86_400_000);
    const to = Math.min(next - 1, scale.end);
    out.push({ from, days: to - from + 1, month: dayOf(from).slice(0, 7) });
    from = to + 1;
  }
  return out;
}

/** Every Monday on the scale. */
export function weeksOf(scale: Scale): number[] {
  const out: number[] = [];
  for (let d = scale.start; d <= scale.end; d += 7) out.push(d);
  return out;
}

/** The day of the month of a day, for the header. */
export const dateOf = (day: number) => Number(dayOf(day).slice(8));

/** Saturday or Sunday. */
export const isWeekend = (day: number) => (((day + 3) % 7) + 7) % 7 >= 5;
