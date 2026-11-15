// How formula values turn into numbers, text and dates: the helpers of
// internal/formula/formula.go, ported so every edge agrees with the server.

import type { Value } from "@/docs/db/formula";

/** Go's %q, near enough: the text in double quotes with escapes. */
export const quote = (s: string) => JSON.stringify(s);

export function isEmpty(v: Value | undefined): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

export function truthy(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return !isEmpty(v);
}

const decimal = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const special = /^([+-]?)(inf|infinity|nan)$/i;

export function num(v: Value | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (decimal.test(s)) return Number.parseFloat(s);
    const m = special.exec(s);
    if (m) return m[2]?.toLowerCase() === "nan" ? Number.NaN : m[1] === "-" ? -Infinity : Infinity;
    if (v === "") return 0;
    throw new Error(`${quote(v)} is not a number`);
  }
  return 0;
}

/** A number the way Go prints it with FormatFloat(x, 'f', -1, 64): the shortest digits, never an exponent. */
function plainNumber(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "+Inf";
  if (x === -Infinity) return "-Inf";
  if (Object.is(x, -0)) return "-0";
  const s = String(x);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[1] ?? "";
  const whole = m[2] ?? "";
  const digits = whole + (m[3] ?? "");
  const point = whole.length + Number(m[4]);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Shows a value the way a cell does. */
export function formulaText(v: Value | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return plainNumber(v);
  if (Array.isArray(v)) return v.map(formulaText).join(", ");
  return JSON.stringify(v);
}

const isSurrogate = (c: number) => c >= 0xd800 && c <= 0xdfff;

/** Compares text the way Go does: by UTF-8 bytes, which is by code point. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // Halves of a character beyond U+FFFF sort above everything below it.
    if (isSurrogate(x) !== isSurrogate(y)) return isSurrogate(x) ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

/**
 * A moment as a formula sees it: `local` is the wall-clock time written in
 * the text, as if it were UTC, and `offset` is its zone's distance from UTC
 * (both in milliseconds). The instant is local - offset.
 */
export interface FDate {
  local: number;
  offset: number;
}

const layouts = [
  /^(\d{4})-(\d{2})-(\d{2})$/,
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([.,]\d+)?(Z|[+-]\d{2}:\d{2})$/,
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([.,]\d+)?$/,
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/,
];

export function parseDate(v: Value | undefined): FDate | null {
  if (typeof v !== "string" || v === "") return null;
  for (const layout of layouts) {
    const m = layout.exec(v);
    if (!m) continue;
    const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const frac = m[7] ? Math.floor(Number(`0.${m[7].slice(1)}`) * 1000) : 0;
    const local = Date.UTC(y, mo - 1, d, h, mi, s, frac);
    const back = new Date(local);
    // Go refuses a day that is not in the month, an hour past 23 and so on.
    if (mo < 1 || mo > 12 || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59)
      continue;
    let offset = 0;
    const zone = m[8];
    if (zone && zone !== "Z") {
      const zh = Number(zone.slice(1, 3));
      const zm = Number(zone.slice(4, 6));
      if (zh > 23 || zm > 59) continue;
      offset = (zone.startsWith("-") ? -1 : 1) * (zh * 60 + zm) * 60_000;
    }
    return { local, offset };
  }
  return null;
}

/** YYYY-MM-DD of a moment, in its own zone. */
export const formatDay = (d: FDate) => new Date(d.local).toISOString().slice(0, 10);

/** Go's time.RFC3339 in UTC: whole seconds and a Z. */
export const formatRFC3339 = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
