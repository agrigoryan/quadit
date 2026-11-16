// What the plan's edits send to be undone (insights/plan/actions.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { clearUndo, nextUndo, redo, undo } from "@/data/undo";
import { useToasts } from "@/lib/toast";
import type { Cycle, Epic, Member, Task, User, Workspace } from "@/types/core";
import { createCycle, deleteEpic, moveToCycle, updateCycle, updateEpic } from "@/insights/plan/actions";

type Sent = { type: string; args: Record<string, unknown> };
let requests: Sent[][] = [];

const settle = () => vi.advanceTimersByTimeAsync(0);
const last = () => (requests.at(-1) ?? []).map(({ type, args }) => ({ type, args }));
const rows = () => getState().collections;

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: Sent[] };
    requests.push(changes);
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  clearStore();
  clearUndo();
  useToasts.setState({ items: [] });
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    epics: [{ id: "e1", project_id: "p", name: "Launch", state: "planned", lead_id: "u2", start_on: "2026-11-01" }],
    cycles: [
      { id: "c1", project_id: "p", number: 1, starts_on: "2026-11-02", ends_on: "2026-11-15" },
      { id: "c2", project_id: "p", number: 2, name: "Polish", starts_on: "2026-11-16", ends_on: "2026-11-29" },
    ],
    tasks: [
      { id: "t1", key: "SVA-1", cycle_id: "c1", epic_id: "e1", milestone_id: "m1" },
      { id: "t2", key: "SVA-2", epic_id: "e1" },
      { id: "t3", key: "SVA-3" },
    ],
  });
});

afterEach(async () => {
  await clearOutbox();
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("undoing a change to the plan", () => {
  it("gives an epic back the lead and the dates it had, and clears the ones it had not", async () => {
    updateEpic(rows().epics.e1 as Epic, { lead: null, start_on: "2026-12-01", target_on: "2026-12-20" });
    expect(rows().epics.e1?.lead_id ?? null).toBeNull();
    await settle();
    expect(nextUndo()?.name).toBe("change Launch");
    undo();
    await settle();
    expect(last()).toEqual([
      { type: "epic.update", args: { id: "e1", lead: "u2", start_on: "2026-11-01", target_on: null } },
    ]);
    expect(rows().epics.e1).toMatchObject({ lead_id: "u2", start_on: "2026-11-01" });
    expect(rows().epics.e1?.target_on ?? null).toBeNull();
  });

  it("brings a deleted epic back, with its tasks in it and each in its milestone", async () => {
    deleteEpic(rows().epics.e1 as Epic);
    expect(rows().tasks.t1?.epic_id ?? null).toBeNull();
    await settle();
    expect(nextUndo()?.name).toBe("delete Launch");
    undo();
    await settle();
    // The epic first: a task cannot be put in one that is in the trash.
    expect(last()).toEqual([
      { type: "epic.restore", args: { id: "e1" } },
      { type: "task.update", args: { id: "t1", epic: "e1", milestone: "m1" } },
      { type: "task.update", args: { id: "t2", epic: "e1", milestone: null } },
    ]);
    expect(rows().epics.e1?.deleted_at ?? null).toBeNull();
    expect(rows().tasks.t1).toMatchObject({ epic_id: "e1", milestone_id: "m1" });
    expect(rows().tasks.t3?.epic_id ?? null).toBeNull();
  });

  it("puts a cycle just made in the trash, and takes it out again on redo", async () => {
    await createCycle("p", 3, "2026-11-30", "2026-12-13");
    const id = requests[0]?.[0]?.args.id;
    expect(nextUndo()?.name).toBe("create cycle 3");
    undo();
    await settle();
    expect(last()).toEqual([{ type: "cycle.delete", args: { id } }]);
    redo();
    await settle();
    expect(last()).toEqual([{ type: "cycle.restore", args: { id } }]);
  });

  it("gives a cycle back its name, or none", async () => {
    updateCycle(rows().cycles.c1 as Cycle, { name: "Sprint one" });
    await settle();
    expect(nextUndo()?.name).toBe("change cycle 1");
    undo();
    await settle();
    expect(last()).toEqual([{ type: "cycle.update", args: { id: "c1", name: "" } }]);
    expect(rows().cycles.c1?.name ?? null).toBeNull();
  });

  it("puts tasks moved to a cycle back where each was, from Cmd+Z or the note's button", async () => {
    moveToCycle([rows().tasks.t1 as Task, rows().tasks.t2 as Task], rows().cycles.c2 as Cycle, "Polish");
    await settle();
    expect(nextUndo()?.name).toBe("move 2 tasks to Polish");
    useToasts.getState().items[0]?.action?.run();
    await settle();
    expect(last().map((c) => c.args)).toEqual([
      { id: "t1", cycle: "c1" },
      { id: "t2", cycle: null },
    ]);
    expect(nextUndo()).toBeUndefined();
  });
});
