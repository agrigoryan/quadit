// Filtering and grouping tasks, and filters to and from a saved view's query (tasks/filters.ts).

import { describe, expect, it } from "vitest";
import { isLive } from "@/data/selectors";
import type { Dict } from "@/data/store";
import type { Cycle, Epic, Label, Member, Project, Status, Task } from "@/types/core";
import {
  emptyFilters,
  type Filters,
  fromQuery,
  groupTasks,
  matcher,
  normalizeQuery,
  sortFromQuery,
  toQuery,
} from "@/tasks/filters";

const byId = <T extends { id: string }>(rows: T[]): Dict<T> => Object.fromEntries(rows.map((r) => [r.id, r]));
/** The table as useLookup hands it over: the gone rows left out. */
const live = <T extends object>(table: Dict<T>): Dict<T> =>
  Object.fromEntries(Object.entries(table).filter(([, row]) => isLive(row)));

const statuses = byId([
  { id: "s-todo", project_id: "p1", name: "To do", category: "unstarted", rank: "a" },
  { id: "s-doing", project_id: "p1", name: "Doing", category: "started", rank: "b" },
  { id: "s-done", project_id: "p1", name: "Done", category: "done", rank: "c" },
  { id: "s-old", project_id: "p1", name: "Old", category: "started", rank: "d", deleted_at: 1 },
  { id: "s-other", project_id: "p2", name: "Doing", category: "started", rank: "a" },
] as Status[]);
const members: Dict<Member> = {
  u1: { user_id: "u1", name: "Ann", handle: "ann", kind: "person" } as Member,
  u2: { user_id: "u2", name: "Bot", handle: "coder", kind: "agent" } as Member,
  u3: { user_id: "u3", name: "Cy", handle: "cy", kind: "person", removed_at: 5 } as Member,
};
const labels = byId([
  { id: "l-bug", name: "bug" },
  { id: "l-art", name: "art", project_id: "p1" },
  { id: "l-gone", name: "gone", deleted_at: 1 },
] as Label[]);
const epics = byId([
  { id: "e1", name: "Launch", project_id: "p1", rank: "a" },
  { id: "e2", name: "Old", project_id: "p1", rank: "b", deleted_at: 1 },
] as Epic[]);
const projects = byId([
  { id: "p1", key: "SVA" },
  { id: "p2", key: "OPS" },
] as Project[]);
const cycles = byId([
  { id: "cy1", project_id: "p1", number: 4, starts_on: "2000-01-01", ends_on: "2000-01-14" },
] as Cycle[]);

let n = 0;
const task = (over: Partial<Task>): Task =>
  ({ id: `t${++n}`, key: `SVA-${n}`, title: "a task", status_id: "s-todo", priority: 0, rank: "m", ...over }) as Task;

const filters = (over: Partial<Filters>): Filters => ({ ...emptyFilters, ...over });

describe("matcher", () => {
  const ids = (f: Partial<Filters>, tasks: Task[], open: Dict<unknown> = {}) =>
    tasks.filter(matcher(filters(f), { statuses }, open, "u1")).map((t) => t.id);

  it("passes every task with no filter set", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", assignee_id: "u1" })];
    expect(ids({}, tasks)).toEqual(["a", "b"]);
  });

  it("matches the assignee, with 'none' for unassigned", () => {
    const tasks = [
      task({ id: "mine", assignee_id: "u1" }),
      task({ id: "theirs", assignee_id: "u2" }),
      task({ id: "free" }),
    ];
    expect(ids({ assignee: ["u1", "none"] }, tasks)).toEqual(["mine", "free"]);
  });

  it("matches a status category through the task's status", () => {
    const tasks = [
      task({ id: "todo" }),
      task({ id: "doing", status_id: "s-doing" }),
      task({ id: "done", status_id: "s-done" }),
    ];
    expect(ids({ category: ["started", "done"] }, tasks)).toEqual(["doing", "done"]);
  });

  it("matches a task with any one of the labels picked", () => {
    const tasks = [
      task({ id: "both", label_ids: ["l-bug", "l-art"] }),
      task({ id: "art", label_ids: ["l-art"] }),
      task({ id: "bare" }),
    ];
    expect(ids({ label: ["l-bug"] }, tasks)).toEqual(["both"]);
    expect(ids({ label: ["l-bug", "l-art"] }, tasks)).toEqual(["both", "art"]);
  });

  it("tells waiting on a person, on an outside event, and on nothing apart", () => {
    const tasks = [
      task({ id: "person", waiting_on_id: "u2" }),
      task({ id: "outside", waiting_outside: true }),
      task({ id: "nothing" }),
    ];
    expect(ids({ waiting: ["u2"] }, tasks)).toEqual(["person"]);
    expect(ids({ waiting: ["outside"] }, tasks)).toEqual(["outside"]);
    expect(ids({ waiting: ["none"] }, tasks)).toEqual(["nothing"]);
  });

  it("tells no estimate and an estimate of 0 apart", () => {
    const tasks = [task({ id: "none" }), task({ id: "zero", estimate: 0 }), task({ id: "three", estimate: 3 })];
    expect(ids({ estimate: ["none"] }, tasks)).toEqual(["none"]);
    expect(ids({ estimate: ["0"] }, tasks)).toEqual(["zero"]);
    expect(ids({ estimate: ["0", "3"] }, tasks)).toEqual(["zero", "three"]);
  });

  it("finds text in the title or the key, whatever its case, and needs every filter to pass", () => {
    const tasks = [
      task({ id: "title", title: "Fix the Login page", priority: 1 }),
      task({ id: "key", key: "SVA-77", priority: 1 }),
      task({ id: "low", title: "login again", priority: 4 }),
    ];
    expect(ids({ text: "  LOGIN " }, tasks)).toEqual(["title", "low"]);
    expect(ids({ text: "sva-77" }, tasks)).toEqual(["key"]);
    expect(ids({ text: "login", priority: ["1"] }, tasks)).toEqual(["title"]);
    expect(ids({ openDecision: true }, tasks, { key: true })).toEqual(["key"]);
  });
});

describe("groupTasks", () => {
  // As a page passes them (tasks/tasks-view.tsx): removed members and deleted epics still name their groups.
  const c = { statuses: live(statuses), members, epics, labels: live(labels) };
  const shape = (groups: ReturnType<typeof groupTasks>) => groups.map((g) => [g.id, g.tasks.map((t) => t.id)]);

  it("groups by the project's own statuses in their order, keeping the empty ones of that project", () => {
    const tasks = [task({ id: "a", status_id: "s-done" }), task({ id: "b", status_id: "s-todo" })];
    expect(shape(groupTasks(tasks, "status", c, "p1"))).toEqual([
      ["s-todo", ["b"]],
      ["s-done", ["a"]],
    ]);
    expect(shape(groupTasks(tasks, "status", c, "p1", true))).toEqual([
      ["s-todo", ["b"]],
      ["s-doing", []],
      ["s-done", ["a"]],
    ]);
  });

  it("groups by category across projects", () => {
    const tasks = [task({ id: "a", status_id: "s-other" }), task({ id: "b", status_id: "s-doing" }), task({ id: "c" })];
    expect(shape(groupTasks(tasks, "status", c, undefined))).toEqual([
      ["unstarted", ["c"]],
      ["started", ["a", "b"]],
    ]);
  });

  it("puts a task in each of its labels' groups, and one with none in 'No label'", () => {
    const tasks = [task({ id: "a", label_ids: ["l-bug", "l-art"] }), task({ id: "b", label_ids: ["l-gone"] })];
    expect(shape(groupTasks(tasks, "label", c, "p1"))).toEqual([
      ["l-art", ["a"]],
      ["l-bug", ["a"]],
      ["none", ["b"]],
    ]);
  });

  it("orders assignees people first, and keeps a removed member's group only while it holds a task", () => {
    const tasks = [task({ id: "a", assignee_id: "u2" }), task({ id: "b" }), task({ id: "c", assignee_id: "u9" })];
    expect(shape(groupTasks(tasks, "assignee", c, "p1", true))).toEqual([
      ["u1", []],
      ["u2", ["a"]],
      ["none", ["b", "c"]],
    ]);
    expect(groupTasks([task({ assignee_id: "u3" })], "assignee", c, "p1").map((g) => g.id)).toEqual(["u3"]);
  });

  it("orders priorities urgent first and 'no priority' last", () => {
    const tasks = [
      task({ id: "none", priority: 0 }),
      task({ id: "low", priority: 4 }),
      task({ id: "urgent", priority: 1 }),
    ];
    expect(shape(groupTasks(tasks, "priority", c, "p1"))).toEqual([
      ["1", ["urgent"]],
      ["4", ["low"]],
      ["0", ["none"]],
    ]);
  });
});

describe("groupTasks headings", () => {
  const c = { statuses: live(statuses), members, epics, labels: live(labels) };
  const heads = (by: Parameters<typeof groupTasks>[1], projectId: string | null = "p1") =>
    groupTasks(
      [
        task({ id: "a", assignee_id: "u1", label_ids: ["l-bug"], epic_id: "e1", priority: 2, status_id: "s-doing" }),
        task({ id: "b" }),
      ],
      by,
      c,
      projectId ?? undefined,
      true,
    ).map((g) => [g.kind, g.id, g.title, g.value, g.category ?? "-"].join(" "));

  it("names each group after what it stands for, with a group for none where a task can have none", () => {
    expect(heads("status")).toEqual([
      "status s-todo To do s-todo unstarted",
      "status s-doing Doing s-doing started",
      "status s-done Done s-done done",
    ]);
    expect(heads("status", null)).toEqual([
      "status backlog Backlog backlog backlog",
      "status unstarted To do unstarted unstarted",
      "status started In progress started started",
      "status waiting Waiting waiting waiting",
      "status done Done done done",
      "status canceled Canceled canceled canceled",
    ]);
    expect(heads("assignee")).toEqual([
      "assignee u1 Ann u1 -",
      "assignee u2 Bot u2 -",
      "assignee none Unassigned none -",
    ]);
    expect(heads("label")).toEqual([
      "label l-art art l-art -",
      "label l-bug bug l-bug -",
      "label none No label none -",
    ]);
    expect(heads("epic")).toEqual(["epic e1 Launch e1 -", "epic none No epic none -"]);
    expect(heads("priority")).toEqual([
      "priority 1 Urgent 1 -",
      "priority 2 High 2 -",
      "priority 3 Medium 3 -",
      "priority 4 Low 4 -",
      "priority 0 No priority 0 -",
    ]);
    expect(heads("none")).toEqual(["none all   -"]);
  });
});

describe("toQuery and fromQuery", () => {
  // As a page passes them (tasks/tasks-view.tsx): what is gone is not there to be found.
  const source = {
    projects,
    members: live(members),
    statuses: live(statuses),
    labels: live(labels),
    epics: live(epics),
    cycles: live(cycles),
  };

  it("give back the same filters and sort", () => {
    const f: Filters = {
      assignee: ["u1", "none"],
      status: ["s-doing"],
      category: ["done"],
      label: ["l-bug"],
      priority: ["1", "2"],
      epic: ["e1", "none"],
      cycle: ["cy1"],
      estimate: ["none", "0", "3"],
      waiting: ["outside"],
      openDecision: true,
      text: "login",
    };
    const q = toQuery(f, "SVA", "due");
    // The server's names for the project and the sort.
    expect(q).toMatchObject({ project: ["SVA"], sort: "due" });
    expect(toQuery(emptyFilters, undefined, "updated")).toEqual({ sort: "-updated" });
    expect(fromQuery(q, source)).toEqual(f);
    expect(sortFromQuery(q)).toBe("due");
    expect(fromQuery(toQuery(emptyFilters, undefined, "manual"), source)).toEqual(emptyFilters);
  });

  it("read names where ids belong, and drop what names nothing or something gone", () => {
    const q = {
      project: ["sva"],
      assignee: ["me", "@Coder", "cy", "nobody"],
      status: ["doing", "Done", "waiting", "nonsense"],
      label: ["BUG", "gone"],
      epic: ["launch", "old"],
      cycle: ["4"],
      estimate: ["M", "5", "NONE", "0", "big", "-1"],
    };
    expect(fromQuery(q, source)).toMatchObject({
      assignee: ["me", "u2"],
      status: ["s-doing", "s-done"],
      category: ["waiting"],
      label: ["l-bug"],
      epic: ["e1"],
      cycle: ["cy1"],
      estimate: ["3", "5", "none", "0"],
    });
  });

  it("read an estimate a view stores as numbers or as one word", () => {
    expect(fromQuery(normalizeQuery({ estimate: [5, 8] }) ?? {}, source).estimate).toEqual(["5", "8"]);
    expect(fromQuery(normalizeQuery({ estimate: "m" }) ?? {}, source).estimate).toEqual(["3"]);
  });

  it("send the estimate as a list of words, as the server reads it", () => {
    expect(toQuery({ ...emptyFilters, estimate: ["none", "0", "5"] }, "SVA", "manual").estimate).toEqual([
      "none",
      "0",
      "5",
    ]);
  });
});
