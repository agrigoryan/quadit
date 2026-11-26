// A project's estimate scale, what a task counts for in totals, and how an
// estimate reads (tasks/estimates.ts).

import { describe, expect, it } from "vitest";
import type { Project, ProjectSettings, Task } from "@/types/core";
import {
  estimateFromWord,
  estimateShort,
  estimateWords,
  pointsOf,
  scaleOf,
  scaleValues,
  sharedScale,
  sizeOf,
} from "@/tasks/estimates";

const project = (settings?: ProjectSettings) => ({ id: "p1", key: "SVA", settings }) as Project;
const task = (estimate?: number) => ({ id: "t1", project_id: "p1", estimate }) as Task;

describe("scaleValues", () => {
  it("has each scale's values as Linear has them, and the two the extended form adds", () => {
    expect(scaleValues("exponential", false)).toEqual([1, 2, 4, 8, 16]);
    expect(scaleValues("exponential", true)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(scaleValues("fibonacci", false)).toEqual([1, 2, 3, 5, 8]);
    expect(scaleValues("fibonacci", true)).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(scaleValues("linear", false)).toEqual([1, 2, 3, 4, 5]);
    expect(scaleValues("linear", true)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(scaleValues("tshirt", true)).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(scaleValues("points", true)).toEqual([]);
  });
});

describe("T-shirt sizes", () => {
  it("stand for Fibonacci's numbers", () => {
    expect([1, 2, 3, 5, 8, 13, 21].map(sizeOf)).toEqual(["XS", "S", "M", "L", "XL", "XXL", "XXXL"]);
    expect(sizeOf(4)).toBeUndefined();
  });

  it("are read without regard to case, as are whole numbers; anything else names nothing", () => {
    expect(estimateFromWord("M")).toBe(3);
    expect(estimateFromWord("xxl")).toBe(13);
    expect(estimateFromWord(" 5 ")).toBe(5);
    expect(estimateFromWord("0")).toBe(0);
    expect(estimateFromWord("none")).toBeUndefined();
    expect(estimateFromWord("-1")).toBeUndefined();
    expect(estimateFromWord("2.5")).toBeUndefined();
  });
});

describe("scaleOf", () => {
  it("is nothing where the project does not estimate, whatever else it says", () => {
    expect(scaleOf(project())).toBeNull();
    expect(scaleOf(project({ estimate_scale: "fibonacci" }))).toBeNull();
    expect(scaleOf(undefined)).toBeNull();
  });

  it("is any whole number where the project names no scale, as before there were scales", () => {
    expect(scaleOf(project({ estimates: true }))).toEqual({ name: "points", values: null, zero: false, sizes: false });
  });

  it("reads a scale it does not know as any whole number", () => {
    const later = { estimates: true, estimate_scale: "golden" } as unknown as ProjectSettings; // as a newer server could send it
    expect(scaleOf(project(later))?.name).toBe("points");
  });

  it("has the scale's values, extended where asked, and says whether 0 is one and whether it reads sizes", () => {
    expect(
      scaleOf(project({ estimates: true, estimate_scale: "tshirt", estimate_extended: true, estimate_zero: true })),
    ).toEqual({ name: "tshirt", values: [1, 2, 3, 5, 8, 13, 21], zero: true, sizes: true });
  });
});

describe("sharedScale", () => {
  const fib = project({ estimates: true, estimate_scale: "fibonacci", estimate_zero: true });
  const tshirt = project({ estimates: true, estimate_scale: "tshirt", estimate_zero: true });
  const exp = project({ estimates: true, estimate_scale: "exponential" });
  const any = project({ estimates: true, estimate_zero: true });

  it("is the one scale of projects that share it", () => {
    expect(sharedScale([tshirt, tshirt])).toEqual(scaleOf(tshirt));
  });

  it("keeps the values every project takes, 0 only where each allows it, sizes only where each reads them", () => {
    expect(sharedScale([fib, exp])).toEqual({ name: "points", values: [1, 2, 8], zero: false, sizes: false });
    expect(sharedScale([tshirt, fib])).toEqual({ name: "points", values: [1, 2, 3, 5, 8], zero: true, sizes: false });
  });

  it("takes a scale's values where another project takes any number", () => {
    expect(sharedScale([any, exp])?.values).toEqual([1, 2, 4, 8, 16]);
    expect(sharedScale([any, any])?.values).toBeNull();
  });

  it("is nothing where one project does not estimate, or there is none", () => {
    expect(sharedScale([fib, project()])).toBeNull();
    expect(sharedScale([])).toBeNull();
  });
});

describe("how an estimate reads", () => {
  const tshirt = scaleOf(project({ estimates: true, estimate_scale: "tshirt" }));
  const fib = scaleOf(project({ estimates: true, estimate_scale: "fibonacci" }));

  it("is the size on a T-shirt project, the number elsewhere", () => {
    expect(estimateShort(3, tshirt)).toBe("M");
    expect(estimateShort(3, fib)).toBe("3");
    expect(estimateWords(3, tshirt)).toBe("M");
    expect(estimateWords(3, fib)).toBe("3 points");
    expect(estimateWords(1, fib)).toBe("1 point");
    expect(estimateWords(0, fib)).toBe("0 points");
  });

  it("is its number of points where it is off the T-shirt scale", () => {
    expect(estimateShort(4, tshirt)).toBe("4");
    expect(estimateWords(4, tshirt)).toBe("4 points");
  });
});

describe("pointsOf", () => {
  it("is 1 for every task where the project does not estimate", () => {
    expect(pointsOf(task(5), project())).toBe(1);
    expect(pointsOf(task(), project())).toBe(1);
  });

  it("is the estimate, 0 included", () => {
    const on = project({ estimates: true });
    expect(pointsOf(task(5), on)).toBe(5);
    expect(pointsOf(task(0), on)).toBe(0);
  });

  it("is 1 for a task without an estimate, or 0 where the project counts those as nothing", () => {
    expect(pointsOf(task(), project({ estimates: true }))).toBe(1);
    expect(pointsOf(task(), project({ estimates: true, estimate_ignore_unestimated: true }))).toBe(0);
  });

  it("takes an estimate cleared here (null until the server's row comes) as none", () => {
    const cleared = { ...task(), estimate: null } as unknown as Task; // as a local patch leaves it
    expect(pointsOf(cleared, project({ estimates: true }))).toBe(1);
  });
});
