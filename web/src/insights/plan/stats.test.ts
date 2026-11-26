// What epics, milestones and cycles add up to, and what a project's cycle
// can hold (insights/plan/stats.ts).

import { describe, expect, it } from "vitest";
import type { Dict } from "@/data/store";
import type { Cycle, Project, ProjectSettings, Status, Task } from "@/types/core";
import { capacityOf, emptyTally, type Tally, tallyOf } from "@/insights/plan/stats";

const status = (id: string, category: Status["category"]) => ({ id, category }) as Status;
const statuses: Dict<Status> = {
  todo: status("todo", "unstarted"),
  done: status("done", "done"),
  gone: status("gone", "canceled"),
};
const projects = (settings?: ProjectSettings): Dict<Project> => ({
  p1: { id: "p1", key: "SVA", settings } as Project,
});
const task = (status: string, estimate?: number) =>
  ({ id: `t-${status}-${estimate}`, project_id: "p1", status_id: status, estimate, updated_at: 0 }) as Task;

describe("tallyOf", () => {
  const tasks = [task("todo", 5), task("todo"), task("done", 0), task("done", 3), task("gone", 8)];

  it("counts each task as 1 point where the project does not estimate", () => {
    expect(tallyOf(tasks, statuses, projects())).toMatchObject({ total: 4, done: 2, points: 4, pointsDone: 2 });
  });

  it("counts estimates, 0 included, and a task without one as 1, leaving out the canceled", () => {
    expect(tallyOf(tasks, statuses, projects({ estimates: true }))).toMatchObject({ points: 9, pointsDone: 3 });
  });

  it("says whether a counted task is in a project that estimates, an empty tally not", () => {
    expect(tallyOf(tasks, statuses, projects({ estimates: true })).estimated).toBe(true);
    expect(tallyOf(tasks, statuses, projects()).estimated).toBe(false);
    expect(tallyOf([], statuses, projects({ estimates: true })).estimated).toBe(false);
    expect(tallyOf([task("gone", 3)], statuses, projects({ estimates: true })).estimated).toBe(false);
  });

  it("counts a task without an estimate as nothing where the project says so", () => {
    const tally = tallyOf(tasks, statuses, projects({ estimates: true, estimate_ignore_unestimated: true }));
    expect(tally).toMatchObject({ points: 8, pointsDone: 3 });
  });
});

describe("capacityOf", () => {
  const cycle = (id: string, starts_on: string, ends_on: string) => ({ id, starts_on, ends_on }) as Cycle;
  const done = (pointsDone: number): Tally => ({ ...emptyTally(), pointsDone });
  const cycles = [
    cycle("c1", "2026-09-01", "2026-09-14"),
    cycle("c2", "2026-09-15", "2026-09-28"),
    cycle("c3", "2026-09-29", "2026-10-12"),
    cycle("c4", "2026-10-13", "2026-10-26"),
    cycle("now", "2026-10-27", "2026-11-09"),
  ];

  it("is the mean done in the three latest cycles that have ended, not rounded", () => {
    const tallies = { c1: done(100), c2: done(10), c3: done(20), c4: done(31), now: done(50) };
    expect(capacityOf(cycles, tallies, "2026-11-01")).toEqual({ points: 61 / 3, cycles: 3 });
  });

  it("counts a cycle that ended with nothing done as 0, and uses fewer cycles where fewer have ended", () => {
    expect(capacityOf(cycles.slice(0, 2), { c1: done(9) }, "2026-11-01")).toEqual({ points: 4.5, cycles: 2 });
  });

  it("is nothing while no cycle has ended", () => {
    expect(capacityOf(cycles, {}, "2026-09-14")).toBeUndefined();
    expect(capacityOf([], {}, "2026-11-01")).toBeUndefined();
  });
});
