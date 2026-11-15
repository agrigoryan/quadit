// Where the task list's groups and rows sit (tasks/list-layout.ts).

import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/types";
import type { TaskGroup } from "@/tasks/filters";
import { layOut, type Row, ROW, rowPlace, rowsBetween, stepFrom, treeStep } from "@/tasks/list-layout";

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

// The tree: sub-tasks under their parents, inside each group.

/** A task numbered n, nested under task `parent`; ranked by its number unless given a rank. */
const sub = (n: number, parent?: number, rank = String(n).padStart(3, "0")) =>
  ({ id: `t${n}`, key: `SVA-${n}`, rank, parent_id: parent === undefined ? undefined : `t${parent}` }) as Task;
const byRank = (a: Task, b: Task) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);

/** Lays out groups of the given tasks, nested, with every task in `all` there to be looked up as a parent. */
function nest(all: Task[], groups: Record<string, number[]>, folded: string[] = []) {
  const tasks = Object.fromEntries(all.map((task) => [task.id, task]));
  const made = Object.entries(groups).map(([id, numbers]) => ({
    ...group(id, []),
    tasks: numbers.map((n) => tasks[`t${n}`] as Task).sort(byRank),
  }));
  return layOut(made, new Set(folded), { tasks, compare: byRank });
}

/** A row as one line: indented by depth, a context row in brackets, a folded parent with a +. */
const line = (row: Row) => {
  const b = row.branch;
  if (!b) return row.task.id;
  const name = b.context ? `(${row.task.id})` : row.task.id;
  return `${"  ".repeat(b.depth)}${name}${b.folded ? "+" : ""}`;
};

describe("layOut, nested", () => {
  const cases: { name: string; all: Task[]; groups: Record<string, number[]>; folded?: string[]; rows: string[] }[] = [
    {
      name: "puts a sub-task under its parent when both are in the group",
      all: [sub(1), sub(2, 1), sub(3, 1), sub(4)],
      groups: { todo: [1, 2, 3, 4] },
      rows: ["t1", "  t2", "  t3", "t4"],
    },
    {
      name: "shows a parent from another group above its sub-task, for context",
      all: [sub(1), sub(2, 1), sub(3)],
      groups: { todo: [2, 3], doing: [1] },
      rows: ["(t1)", "  t2", "t3", "t1"],
    },
    {
      name: "shows the same parent in each group that holds one of its sub-tasks",
      all: [sub(1), sub(2, 1), sub(3, 1), sub(4, 1)],
      groups: { todo: [2, 3], idea: [4], doing: [1] },
      rows: ["(t1)", "  t2", "  t3", "(t1)", "  t4", "t1"],
    },
    {
      name: "nests three levels deep",
      all: [sub(1), sub(2, 1), sub(3, 2)],
      groups: { todo: [1, 2, 3] },
      rows: ["t1", "  t2", "    t3"],
    },
    {
      name: "adds only the direct parent, nested under its own parent when that one is in the group",
      all: [sub(1), sub(2, 1), sub(3, 2), sub(5), sub(6, 5), sub(7, 6)],
      groups: { todo: [1, 3, 7] },
      rows: ["t1", "  (t2)", "    t3", "(t6)", "  t7"],
    },
    {
      name: "shows a parent the filters leave out, and leaves a sub-task whose parent is not there at the top",
      all: [sub(1), sub(2, 1), sub(3, 9)],
      groups: { todo: [2, 3] },
      rows: ["(t1)", "  t2", "t3"],
    },
    {
      name: "sorts a context row where its parent would sort, and sub-tasks by the same sort under it",
      all: [
        sub(1, undefined, "050"),
        sub(2, 1, "090"),
        sub(3, 1, "010"),
        sub(4, undefined, "020"),
        sub(5, undefined, "080"),
      ],
      groups: { todo: [2, 3, 4, 5] },
      rows: ["t4", "(t1)", "  t3", "  t2", "t5"],
    },
    {
      name: "leaves a folded parent's sub-tasks out",
      all: [sub(1), sub(2, 1), sub(3, 2), sub(4)],
      groups: { todo: [1, 2, 3, 4] },
      folded: ["todo:t1"],
      rows: ["t1+", "t4"],
    },
    {
      name: "folds a parent in one group only",
      all: [sub(1), sub(2, 1), sub(3, 1)],
      groups: { todo: [2], idea: [3] },
      folded: ["todo:t1"],
      rows: ["(t1)+", "(t1)", "  t3"],
    },
    {
      name: "breaks a cycle in bad data at the first task in order",
      all: [{ ...sub(1), parent_id: "t2" }, sub(2, 1), { ...sub(3), parent_id: "t3" }],
      groups: { todo: [1, 2, 3] },
      rows: ["t1", "  t2", "t3"],
    },
  ];
  it.each(cases)("$name", ({ all, groups, folded, rows }) => {
    expect(nest(all, groups, folded).rows.map(line)).toEqual(rows);
  });

  it("counts context rows in the section's height but not as the group's tasks", () => {
    const { sections } = nest([sub(1), sub(2, 1)], { todo: [2], doing: [1] });
    expect(sections[0]).toMatchObject({ rows: 2, height: 32 + 2 * ROW });
    expect(sections[0]?.group.tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("says where the tree's lines run: on past a row while a later sibling is below", () => {
    const { rows } = nest([sub(1), sub(2, 1), sub(3, 2), sub(4, 1)], { todo: [1, 2, 3, 4] });
    expect(rows.map((row) => [row.task.id, row.branch?.rails, row.branch?.children])).toEqual([
      ["t1", [], 2],
      ["t2", [true], 1],
      ["t3", [true, false], 0],
      ["t4", [false], 0],
    ]);
    expect(rows.map((row) => [row.branch?.position, row.branch?.siblings])).toEqual([
      [1, 1],
      [1, 2],
      [1, 1],
      [2, 2],
    ]);
  });

  it("gives no row a branch when nothing in the list is nested, so no room is kept for a fold control", () => {
    expect(nest([sub(1), sub(2)], { todo: [1, 2] }).rows.map((row) => row.branch)).toEqual([undefined, undefined]);
  });

  it("lays out flat, as grouped, when not asked to nest", () => {
    const { rows } = layOut([{ ...group("todo", []), tasks: [sub(1), sub(2, 1)] }], new Set());
    expect(rows.map(line)).toEqual(["t1", "t2"]);
  });
});

describe("treeStep", () => {
  const { rows } = nest([sub(1), sub(2, 1), sub(3, 2), sub(4)], { todo: [1, 2, 3, 4] });
  const folded = nest([sub(1), sub(2, 1), sub(4)], { todo: [1, 2, 4] }, ["todo:t1"]).rows;
  it.each([
    { name: "Left folds an open parent", rows, at: 0, by: -1, out: { toggle: "todo:t1" } },
    { name: "Left on a sub-task goes to its parent", rows, at: 2, by: -1, out: { focus: 1 } },
    { name: "Left on a top row with nothing under it does nothing", rows, at: 3, by: -1, out: undefined },
    { name: "Right unfolds a folded parent", rows: folded, at: 0, by: 1, out: { toggle: "todo:t1" } },
    { name: "Right on an open parent goes to its first sub-task", rows, at: 1, by: 1, out: { focus: 2 } },
    { name: "Right on a row with no sub-tasks does nothing", rows, at: 3, by: 1, out: undefined },
    { name: "nothing without a focused row", rows, at: -1, by: 1, out: undefined },
  ])("$name", ({ rows, at, by, out }) => {
    expect(treeStep(rows, at, by)).toEqual(out);
  });

  it("leaves J and K to walk every row shown, context rows too", () => {
    const shown = nest([sub(1), sub(2, 1)], { todo: [2], doing: [1] }).rows;
    const walked = [-1, 0, 1].map((from) => shown[stepFrom(from, 1, shown.length)]?.key);
    expect(walked).toEqual(["todo:t1", "todo:t2", "doing:t1"]);
  });
});
