// Each filter of a task page from its address (tasks/url-filters.ts): the
// tasks an address lets through, the address written back for what it read,
// and the saved view's query (tasks/filters.ts toQuery) it stands for.

import { describe, expect, it } from "vitest";
import type { Dict } from "@/data/store";
import type { Cycle, Epic, Label, Member, Project, Status, Task } from "@/types/core";
import { matcher, toQuery } from "@/tasks/filters";
import { filtersFromSearch, hasFilters, searchFromFilters } from "@/tasks/url-filters";

const byId = <T extends { id: string }>(rows: T[]): Dict<T> => Object.fromEntries(rows.map((r) => [r.id, r]));

const statuses = byId([
  { id: "s-todo", project_id: "p1", name: "To do", category: "unstarted", rank: "a" },
  { id: "s-doing", project_id: "p1", name: "Doing", category: "started", rank: "b" },
  { id: "s-done", project_id: "p1", name: "Done", category: "done", rank: "c" },
] as Status[]);
const source = {
  projects: byId([{ id: "p1", key: "SVA", settings: { estimates: true, estimate_scale: "tshirt" } }] as Project[]),
  members: {
    u1: { user_id: "u1", name: "Ann", handle: "ann", kind: "person" } as Member,
    u2: { user_id: "u2", name: "Bot", handle: "coder", kind: "agent" } as Member,
  },
  statuses,
  labels: byId([
    { id: "l-bug", name: "bug" },
    { id: "l-art", name: "art", project_id: "p1" },
  ] as Label[]),
  epics: byId([{ id: "e1", name: "Launch", project_id: "p1", rank: "a" }] as Epic[]),
  cycles: byId([{ id: "cy1", project_id: "p1", number: 4, starts_on: "2000-01-01", ends_on: "2999-12-31" }] as Cycle[]),
};

const task = (id: string, over: Partial<Task> = {}): Task =>
  ({
    id,
    key: `SVA-${id}`,
    title: `Task ${id}`,
    project_id: "p1",
    status_id: "s-todo",
    priority: 0,
    rank: "m",
    ...over,
  }) as Task;

const TASKS = [
  task("plain"),
  task("ann", { assignee_id: "u1", label_ids: ["l-bug"], priority: 1, epic_id: "e1", cycle_id: "cy1", estimate: 3 }),
  task("bot", {
    assignee_id: "u2",
    status_id: "s-doing",
    label_ids: ["l-art"],
    priority: 3,
    waiting_on_id: "u1",
    estimate: 0,
  }),
  task("done", { status_id: "s-done", waiting_outside: true }),
];

const read = (search: string) => filtersFromSearch(search, source, "u1", "2000-01-05", "SVA");
/** The tasks an address lets through. */
const shown = (search: string, open: Dict<unknown> = {}) => {
  const f = read(search);
  if (!f) return null;
  return TASKS.filter(matcher(f, { statuses }, open)).map((t) => t.id);
};
/** The address written back for what an address was read as. */
const again = (search: string) => {
  const f = read(search);
  return f && decodeURIComponent(searchFromFilters(f, source, "p1", ""));
};

describe("a task page's filters in its address", () => {
  it("assignee: by handle, me, or none", () => {
    expect(shown("?assignee=@coder")).toEqual(["bot"]);
    expect(shown("?assignee=me,none")).toEqual(["plain", "ann", "done"]);
    expect(again("?assignee=me,none")).toBe("?assignee=@ann,none");
    expect(toQuery(read("?assignee=@coder,none")!, "SVA", "manual")).toMatchObject({
      assignee: ["u2", "none"],
    });
  });

  it("status: by name; a category's name reads as the status type", () => {
    expect(shown("?status=Doing")).toEqual(["bot"]);
    expect(again("?status=Doing")).toBe("?status=Doing");
    expect(shown("?status=done")).toEqual(["done"]);
    expect(again("?status=s-doing")).toBe("?status=Doing");
    expect(toQuery(read("?status=Doing")!, "SVA", "manual")).toMatchObject({ status: ["s-doing"] });
  });

  it("category: the status type", () => {
    expect(shown("?category=started,done")).toEqual(["bot", "done"]);
    expect(again("?category=started,done")).toBe("?category=started,done");
    expect(toQuery(read("?category=done")!, "SVA", "manual")).toMatchObject({ category: ["done"] });
  });

  it("label: by name, any one of them", () => {
    expect(shown("?label=bug")).toEqual(["ann"]);
    expect(shown("?label=bug,art")).toEqual(["ann", "bot"]);
    expect(again("?label=l-art")).toBe("?label=art");
    expect(toQuery(read("?label=bug")!, "SVA", "manual")).toMatchObject({ label: ["l-bug"] });
  });

  it("priority: by number", () => {
    expect(shown("?priority=1,3")).toEqual(["ann", "bot"]);
    expect(again("?priority=1,3")).toBe("?priority=1,3");
    expect(toQuery(read("?priority=3")!, "SVA", "manual")).toMatchObject({ priority: [3] });
  });

  it("epic: by name, or none", () => {
    expect(shown("?epic=launch")).toEqual(["ann"]);
    expect(shown("?epic=none")).toEqual(["plain", "bot", "done"]);
    expect(again("?epic=e1,none")).toBe("?epic=Launch,none");
    expect(toQuery(read("?epic=Launch")!, "SVA", "manual")).toMatchObject({ epic: ["e1"] });
  });

  it("cycle: by number or current, written back as ids", () => {
    expect(shown("?cycle=4")).toEqual(["ann"]);
    expect(shown("?cycle=current")).toEqual(["ann"]);
    expect(shown("?cycle=none")).toEqual(["plain", "bot", "done"]);
    expect(again("?cycle=4")).toBe("?cycle=cy1");
    expect(toQuery(read("?cycle=4")!, "SVA", "manual")).toMatchObject({ cycle: ["cy1"] });
  });

  it("estimate: by number or T-shirt size, or none, written back as the size on a T-shirt project", () => {
    expect(shown("?estimate=m")).toEqual(["ann"]);
    expect(shown("?estimate=3")).toEqual(["ann"]);
    expect(shown("?estimate=0")).toEqual(["bot"]);
    expect(shown("?estimate=none")).toEqual(["plain", "done"]);
    expect(again("?estimate=3,none,0")).toBe("?estimate=M,none,0");
    expect(toQuery(read("?estimate=M,none")!, "SVA", "manual")).toMatchObject({ estimate: ["3", "none"] });
  });

  it("waiting_on: a person, an outside event, or nothing", () => {
    expect(shown("?waiting_on=@ann")).toEqual(["bot"]);
    expect(shown("?waiting_on=outside")).toEqual(["done"]);
    expect(shown("?waiting_on=none")).toEqual(["plain", "ann"]);
    expect(again("?waiting_on=u1")).toBe("?waiting_on=@ann");
    expect(toQuery(read("?waiting_on=outside")!, "SVA", "manual")).toMatchObject({ waiting_on: "outside" });
  });

  it("has_open_decision and q", () => {
    expect(shown("?has_open_decision=1", { bot: true })).toEqual(["bot"]);
    expect(shown("?q=task%20an")).toEqual(["ann"]);
    expect(again("?has_open_decision=true&q=x")).toBe("?has_open_decision=1&q=x");
  });

  it("writes every filter in one order, and keeps what else the address carried", () => {
    const all =
      "?q=x&waiting_on=none&estimate=5&cycle=4&epic=none&priority=2&label=bug&category=done&status=Doing&assignee=me";
    expect(again(all)).toBe(
      "?assignee=@ann&status=Doing&category=done&label=bug&priority=2&epic=none&cycle=cy1&estimate=L&waiting_on=none&q=x",
    );
    const f = read("?label=bug");
    expect(f && searchFromFilters(f, source, "p1", "?view=board&label=art")).toBe("?view=board&label=bug");
    expect(hasFilters("?view=board")).toBe(false);
    expect(hasFilters("?waiting_on=none")).toBe(true);
    expect(read("?view=board")).toBeNull();
  });
});
