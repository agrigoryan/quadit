// Where the task list's groups and rows sit (tasks/list-layout.ts).

import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/types";
import type { TaskGroup } from "@/tasks/filters";
import { layOut, ROW, rowPlace, rowsBetween, stepFrom } from "@/tasks/list-layout";

const task = (n: number) => ({ id: `t${n}`, key: `SVA-${n}` }) as Task;
const group = (id: string, numbers: number[], kind: TaskGroup["kind"] = "status"): TaskGroup => ({
  id,
  title: id,
  kind,
  value: id,
  tasks: numbers.map(task),
});

const GROUPS = [group("todo", [1, 2]), group("doing", [3, 4, 5]), group("done", [6])];

describe("layOut", () => {
  it("puts each group under the last, a heading over its rows", () => {
    const { sections, rows, total } = layOut(GROUPS, new Set());
    expect(sections.map((s) => [s.top, s.height, s.first, s.rows])).toEqual([
      [0, 32 + 2 * ROW, 0, 2],
      [32 + 2 * ROW, 32 + 3 * ROW, 2, 3],
      [64 + 5 * ROW, 32 + ROW, 5, 1],
    ]);
    expect(rows.map((row) => row.key)).toEqual(["todo:t1", "todo:t2", "doing:t3", "doing:t4", "doing:t5", "done:t6"]);
    expect(total).toBe(96 + 6 * ROW);
  });

  it("leaves a folded group's rows out, keeping its heading", () => {
    const { sections, rows, indexOf } = layOut(GROUPS, new Set(["doing"]));
    expect(sections[1]).toMatchObject({ rows: 0, height: 32, first: 2 });
    expect(rows.map((row) => row.task.id)).toEqual(["t1", "t2", "t6"]);
    expect(indexOf.get("done:t6")).toBe(2);
    expect(indexOf.has("doing:t3")).toBe(false);
  });

  it("gives an ungrouped list no heading", () => {
    const { sections } = layOut([group("all", [1], "none")], new Set());
    expect(sections[0]).toMatchObject({ head: 0, height: ROW });
  });

  it("lists a task under every group it is in", () => {
    const { rows } = layOut([group("art", [1]), group("bug", [1])], new Set());
    expect(rows.map((row) => row.key)).toEqual(["art:t1", "bug:t1"]);
  });
});

describe("stepFrom", () => {
  it("steps within the list and stops at its ends", () => {
    expect(stepFrom(0, 1, 3)).toBe(1);
    expect(stepFrom(2, 1, 3)).toBe(2);
    expect(stepFrom(0, -1, 3)).toBe(0);
  });

  it("starts at the first row going down from none, at the last going up", () => {
    expect(stepFrom(-1, 1, 3)).toBe(0);
    expect(stepFrom(-1, -1, 3)).toBe(2);
  });

  it("goes from the last row of a group over a folded one to the next group's first", () => {
    const { rows } = layOut(GROUPS, new Set(["doing"]));
    expect(rows[stepFrom(1, 1, rows.length)]?.task.id).toBe("t6");
    expect(rows[stepFrom(2, -1, rows.length)]?.task.id).toBe("t2");
  });
});

describe("rowPlace and rowsBetween", () => {
  it("places a row under its group's heading", () => {
    const { sections } = layOut(GROUPS, new Set(["doing"]));
    expect(rowPlace(sections, 1)).toEqual({ top: 32 + ROW, head: 32 });
    expect(rowPlace(sections, 2)).toEqual({ top: 32 + 2 * ROW + 32 + 32, head: 32 });
  });

  it("draws only the rows between two heights", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i);
    const { sections } = layOut([group("many", hundred)], new Set());
    const section = sections[0];
    if (!section) throw new Error("no section");
    expect(rowsBetween(section, 0, 32 + 10 * ROW)).toEqual({ start: 0, end: 10 });
    expect(rowsBetween(section, 32 + 50 * ROW, 32 + 60 * ROW)).toEqual({ start: 50, end: 60 });
    expect(rowsBetween(section, 32 + 200 * ROW, 32 + 210 * ROW)).toEqual({ start: 100, end: 100 });
  });
});
