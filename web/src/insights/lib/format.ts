// How the insight pages write amounts, lengths of time and calendar days.

import { formatNumber, t } from "@/lib/i18n";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Money from the server's decimal string ("6.20") or a number of dollars. */
export function money(value: string | number | undefined): string {
  return amount.format(Number(value ?? 0) || 0);
}

/** Money from millionths of a dollar, as sessions record cost. */
export const moneyMicros = (micros: number | undefined) => amount.format((micros ?? 0) / 1e6);

/** A count as people read it: 116445 as "116,445". Not for keys, ids or what goes in a field. */
export const count = (n: number | undefined) => formatNumber(n ?? 0);

/** 182000 as "182K". */
export const short = (n: number | undefined) => compact.format(n ?? 0);

/** A stretch of minutes: "45m", "3h 05m", "2d 4h". */
export function minutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  if (m < 60) return t("ins.time.m", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("ins.time.hm", { h, m: String(m % 60).padStart(2, "0") });
  return t("ins.time.dh", { d: Math.floor(h / 24), h: h % 24 });
}

/** A stretch of hours as the server counts waits (3.4): "3h 24m", "2d 4h". */
export const hours = (h: number) => minutes(h * 60);

/** A stretch of milliseconds. */
export const span = (ms: number) => minutes(ms / MIN);

/** The server writes moments as "2026-11-14 20:57" in UTC; this is that moment in milliseconds, or 0. */
export function parseWhen(when: string | undefined): number {
  if (!when) return 0;
  const ms = Date.parse(`${when.replace(" ", "T")}:00Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

// ---- calendar days ("YYYY-MM-DD") ----

/** A day as a count of days since 1970, so days can be subtracted. */
export function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / DAY);
}

export function dayOf(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export const addDays = (day: string, days: number) => dayOf(dayNumber(day) + days);
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

/** The calendar day a moment falls on, in the person's own time zone. */
export function dayOfMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
