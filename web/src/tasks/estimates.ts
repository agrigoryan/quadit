// How a project estimates its tasks: the scales it picks from (the same
// table as the server's), what a task counts for in totals, and how an
// estimate reads. A task's estimate is left out where it has none; 0 is an
// estimate of its own, where the project allows it.

import { t } from "@/lib/i18n";
import type { EstimateScale, Project, Task } from "@/types/core";

/** The scales, in the order the project's settings offer them. */
export const SCALES: EstimateScale[] = ["fibonacci", "exponential", "linear", "tshirt", "points"];

/** Each scale's values and the two its extended form adds. "points" has none: any whole number. */
const VALUES: Record<Exclude<EstimateScale, "points">, { values: number[]; extended: number[] }> = {
  fibonacci: { values: [1, 2, 3, 5, 8], extended: [13, 21] },
  exponential: { values: [1, 2, 4, 8, 16], extended: [32, 64] },
  linear: { values: [1, 2, 3, 4, 5], extended: [6, 7] },
  tshirt: { values: [1, 2, 3, 5, 8], extended: [13, 21] },
};

/** The T-shirt sizes and the points each stands for, which follow Fibonacci. */
const SIZES: [string, number][] = [
  ["XS", 1],
  ["S", 2],
  ["M", 3],
  ["L", 5],
  ["XL", 8],
  ["XXL", 13],
  ["XXXL", 21],
];

/** How a project's tasks are estimated. */
export interface Scale {
  name: EstimateScale;
  /** What an estimate is picked from, smallest first, 0 left out; null where any whole number is typed. */
  values: number[] | null;
  /** 0 is an estimate, apart from none. */
  zero: boolean;
  /** Estimates read as T-shirt sizes ("M"). */
  sizes: boolean;
}

/** A scale's values, with or without its extended ones; empty for "points". */
export function scaleValues(name: EstimateScale, extended: boolean): number[] {
  if (name === "points") return [];
  const { values, extended: more } = VALUES[name];
  return extended ? [...values, ...more] : values;
}

/** The values the extended form of a scale adds; empty for "points". */
export const extendedValues = (name: EstimateScale): number[] => (name === "points" ? [] : VALUES[name].extended);

/**
 * How the project estimates, or null where it does not. A project that
 * names no scale estimates in any whole number, as projects did before
 * there were scales.
 */
export function scaleOf(project: Project | undefined): Scale | null {
  const settings = project?.settings;
  if (!settings?.estimates) return null;
  const name = settings.estimate_scale || "points";
  return {
    name,
    values: name === "points" ? null : scaleValues(name, !!settings.estimate_extended),
    zero: !!settings.estimate_zero,
    sizes: name === "tshirt",
  };
}

/**
 * What can be set on tasks of all these projects at once: the values every
 * one of them takes (a project of any number takes them all), 0 only where
 * each allows it, sizes only where each reads them. Null where one of them
 * does not estimate.
 */
export function sharedScale(projects: (Project | undefined)[]): Scale | null {
  const scales = projects.map(scaleOf);
  if (scales.length === 0 || scales.some((s) => s === null)) return null;
  return (scales as Scale[]).reduce((a, b) => {
    const values = a.values && b.values ? a.values.filter((v) => b.values?.includes(v)) : (a.values ?? b.values);
    return {
      name: a.name === b.name ? a.name : "points",
      values,
      zero: a.zero && b.zero,
      sizes: a.sizes && b.sizes,
    };
  });
}

/** The T-shirt size a number of points is, if it is one. */
export const sizeOf = (points: number): string | undefined => SIZES.find(([, n]) => n === points)?.[0];

/** The number a word names: a whole number ("5"), or a T-shirt size in any case ("m"); undefined for anything else. */
export function estimateFromWord(word: string): number | undefined {
  const plain = word.trim();
  if (/^\d+$/.test(plain)) return Number(plain);
  return SIZES.find(([size]) => size === plain.toUpperCase())?.[1];
}

/** An estimate as a short word: the size where the project reads sizes ("M"), the number elsewhere ("3"). */
export const estimateShort = (value: number, scale: Scale | null): string =>
  (scale?.sizes && sizeOf(value)) || String(value);

/** An estimate with its unit where the number alone would not say it: "M", "3 points". */
export const estimateWords = (value: number, scale: Scale | null): string =>
  (scale?.sizes && sizeOf(value)) || t("prop.points", { n: value });

/**
 * What a task counts for in totals (a cycle's, an epic's, a group's,
 * capacity): 1 where its project does not estimate; its estimate, 0
 * included, where it has one; and 1 without one, or 0 where the project
 * counts a task without an estimate as nothing.
 */
export function pointsOf(task: Task, project: Project | undefined): number {
  const settings = project?.settings;
  if (!settings?.estimates) return 1;
  return task.estimate ?? (settings.estimate_ignore_unestimated ? 0 : 1);
}
