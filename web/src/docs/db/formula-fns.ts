// The functions a formula can call: a port of the call() switch of
// internal/formula/formula.go, with the helpers only it uses.

import type { Env, Value } from "@/docs/db/formula";
import {
  type FDate,
  formatDay,
  formatRFC3339,
  formulaText,
  isEmpty,
  num,
  parseDate,
  truthy,
} from "@/docs/db/formula-values";

/** What a formula can call, for the editor's help. */
export const FUNCTIONS = [
  "prop",
  "if",
  "concat",
  "length",
  "lower",
  "upper",
  "contains",
  "empty",
  "round",
  "floor",
  "ceil",
  "abs",
  "min",
  "max",
  "sum",
  "toNumber",
  "format",
  "now",
  "today",
  "dateAdd",
  "dateDiff",
] as const;

/** Calls one function with its arguments already worked out. Throws what the cell should say when it cannot. */
export function callFunction(name: string, a: Value[], env: Env, now: Date): Value {
  const arg = (i: number): Value => {
    if (i >= a.length) throw new Error(`${name} needs at least ${i + 1} arguments`);
    return a[i] as Value;
  };
  switch (name) {
    case "prop":
      return env.prop ? (env.prop(formulaText(arg(0))) ?? null) : null;
    case "if":
      if (truthy(arg(0))) return arg(1);
      return a.length > 2 ? (a[2] as Value) : null;
    case "concat":
      return a.map(formulaText).join("");
    case "length":
      return [...formulaText(arg(0))].length;
    case "lower":
      return formulaText(arg(0)).toLowerCase();
    case "upper":
      return formulaText(arg(0)).toUpperCase();
    case "contains": {
      const hay = formulaText(arg(0)).toLowerCase();
      return hay.includes(formulaText(arg(1)).toLowerCase());
    }
    case "empty":
      return isEmpty(arg(0));
    case "round": {
      const scale = a.length > 1 ? 10 ** num(a[1] as Value) : 1;
      return roundHalfAway(num(arg(0)) * scale) / scale;
    }
    case "floor":
      return Math.floor(num(arg(0)));
    case "ceil":
      return Math.ceil(num(arg(0)));
    case "abs":
      return Math.abs(num(arg(0)));
    case "min":
    case "max":
    case "sum": {
      const vals = flatten(a);
      if (vals.length === 0) return null;
      let out = num(vals[0] as Value);
      for (const v of vals.slice(1)) {
        const n = num(v);
        out = name === "min" ? Math.min(out, n) : name === "max" ? Math.max(out, n) : out + n;
      }
      return out;
    }
    case "toNumber":
      return num(arg(0));
    case "format":
      return formulaText(arg(0));
    case "now":
      return formatRFC3339(now);
    case "today":
      return now.toISOString().slice(0, 10);
    case "dateAdd": {
      const d = parseDate(arg(0));
      if (!d) return null;
      const n = Math.trunc(num(arg(1)));
      const u = unit(a, 2);
      return formatDay(
        addDate(
          d,
          u === "years" ? n : 0,
          u === "months" ? n : 0,
          u === "weeks" ? 7 * n : u === "months" || u === "years" ? 0 : n,
        ),
      );
    }
    case "dateDiff": {
      const x = parseDate(arg(0));
      const y = parseDate(arg(1));
      if (!x || !y) return null;
      const hours = (x.local - x.offset - (y.local - y.offset)) / 3_600_000;
      const xd = new Date(x.local);
      const yd = new Date(y.local);
      switch (unit(a, 2)) {
        case "hours":
          return Math.trunc(hours);
        case "weeks":
          return Math.trunc(hours / 24 / 7);
        case "months":
          return (xd.getUTCFullYear() - yd.getUTCFullYear()) * 12 + xd.getUTCMonth() - yd.getUTCMonth();
        case "years":
          return xd.getUTCFullYear() - yd.getUTCFullYear();
      }
      return Math.trunc(hours / 24);
    }
  }
  throw new Error(`unknown function ${name}; functions are: ${FUNCTIONS.join(", ")}`);
}

/** Rounds half away from zero, like Go's math.Round. */
function roundHalfAway(x: number): number {
  if (!Number.isFinite(x)) return x;
  const whole = Math.trunc(x);
  return Math.abs(x - whole) >= 0.5 ? whole + Math.sign(x) : whole;
}

/** Go's Time.AddDate: add to the calendar fields, then let overflowing days roll over. */
function addDate(d: FDate, years: number, months: number, days: number): FDate {
  const t = new Date(d.local);
  const local = Date.UTC(
    t.getUTCFullYear() + years,
    t.getUTCMonth() + months,
    t.getUTCDate() + days,
    t.getUTCHours(),
    t.getUTCMinutes(),
    t.getUTCSeconds(),
    t.getUTCMilliseconds(),
  );
  return { local, offset: d.offset };
}

function unit(a: Value[], i: number): string {
  if (i >= a.length) return "days";
  const u = formulaText(a[i] as Value).toLowerCase();
  return u.endsWith("s") ? u : `${u}s`;
}

function flatten(a: Value[]): Value[] {
  const out: Value[] = [];
  for (const v of a) {
    if (Array.isArray(v)) out.push(...flatten(v));
    else if (!isEmpty(v)) out.push(v);
  }
  return out;
}
