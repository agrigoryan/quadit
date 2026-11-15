// What the timeline says for each field of a task that changed
// (detail/timeline-phrases.ts changePhrases): names, never ids, and the
// order the phrases are said in when one change carries several.

import { beforeEach, describe, expect, it } from "vitest";
import { changePhrases } from "@/detail/timeline-phrases";
import type { Changes } from "@/tasks/properties/property";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    statuses: [
      { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
      { id: "s2", project_id: "p1", name: "Doing", category: "started", rank: "b" },
    ],
    members: [
      { user_id: "u1", handle: "ann", name: "Ann", kind: "person" },
      { user_id: "u2", handle: "coder", name: "Coder", kind: "agent" },
    ],
    labels: [
      { id: "l1", name: "bug" },
      { id: "l2", name: "art" },
    ],
    epics: [{ id: "e1", project_id: "p1", name: "Launch", rank: "a" }],
    milestones: [{ id: "m1", epic_id: "e1", name: "Beta", rank: "a" }],
    cycles: [
      { id: "c1", project_id: "p1", number: 4, starts_on: "2026-11-02", ends_on: "2026-11-15" },
      { id: "c2", project_id: "p1", number: 5, name: "Polish", starts_on: "2026-11-16", ends_on: "2026-11-29" },
    ],
    tasks: [{ id: "t9", project_id: "p1", number: 9, key: "SVA-9", title: "Parent", status_id: "s1", priority: 0 }],
  });
});

const say = (changes: Changes, data: Record<string, unknown> = {}) => changePhrases(changes, "u1", data);

describe("changePhrases", () => {
  it("status", () => {
    expect(say({ status_id: { from: "s1", to: "s2" } })).toEqual(["moved this from Todo to Doing"]);
    expect(say({ status_id: { from: "gone", to: "s2" } })).toEqual(["moved this to Doing"]);
    expect(say({ status_id: { from: "s1", to: "gone" } })).toEqual([]);
  });

  it("assignee", () => {
    expect(say({ assignee_id: { from: null, to: "u2" } })).toEqual(["assigned this to @coder"]);
    expect(say({ assignee_id: { from: null, to: "u1" } })).toEqual(["took this"]);
    expect(say({ assignee_id: { from: "u1", to: null } })).toEqual(["removed the assignee"]);
  });

  it("waiting on someone, on an outside event, and its note", () => {
    expect(say({ waiting_on_id: { from: null, to: "u2" } })).toEqual(["asked @coder to act"]);
    expect(say({ waiting_on_id: { from: null, to: "u2" }, waiting_on_note: { from: null, to: "review it" } })).toEqual([
      "asked @coder to act: review it",
    ]);
    expect(say({ waiting_on_id: { from: "u2", to: null } })).toEqual(["cleared who this waits on"]);
    expect(say({ waiting_on_id: { from: "u2", to: null }, waiting_outside: { from: null, to: true } })).toEqual([
      "set this to wait on an outside event",
    ]);
    expect(
      say({ waiting_outside: { from: null, to: true }, waiting_on_note: { from: null, to: "the store" } }),
    ).toEqual(["set this to wait on an outside event: the store"]);
    expect(say({ waiting_outside: { from: true, to: null } })).toEqual(["cleared who this waits on"]);
    expect(say({ waiting_on_note: { from: null, to: "sooner" } })).toEqual(["changed the waiting note to: sooner"]);
    expect(say({ waiting_on_note: { from: "x", to: "" } })).toEqual(["cleared the waiting note"]);
  });

  it("budget", () => {
    expect(say({ budget: { from: null, to: { minutes: 5 } } })).toEqual(["set the task's budget"]);
    expect(say({ budget: { from: { minutes: 5 }, to: null } })).toEqual(["removed the task's budget"]);
  });

  it("priority", () => {
    expect(say({ priority: { from: 0, to: 2 } })).toEqual(["set the priority to High"]);
    expect(say({ priority: { from: 2, to: 0 } })).toEqual(["cleared the priority"]);
  });

  it("labels, added and removed", () => {
    expect(say({ label_ids: { from: ["l1"], to: ["l2"] } })).toEqual(["added the label art", "removed the label bug"]);
    expect(say({ label_ids: { from: null, to: ["l1", "l2"] } })).toEqual(["added the labels bug and art"]);
  });

  it("epic, milestone and cycle", () => {
    expect(say({ epic_id: { from: null, to: "e1" } })).toEqual(["added this to the epic Launch"]);
    expect(say({ epic_id: { from: "e1", to: null } })).toEqual(["removed this from its epic"]);
    expect(say({ epic_id: { from: null, to: "gone" } })).toEqual([]);
    expect(say({ milestone_id: { from: null, to: "m1" } })).toEqual(["set the milestone to Beta"]);
    expect(say({ milestone_id: { from: "m1", to: null } })).toEqual(["cleared the milestone"]);
    expect(say({ cycle_id: { from: null, to: "c1" } })).toEqual(["added this to Cycle 4"]);
    expect(say({ cycle_id: { from: null, to: "c2" } })).toEqual(["added this to Polish"]);
    expect(say({ cycle_id: { from: "c1", to: null } })).toEqual(["removed this from its cycle"]);
  });

  it("estimate, due date and parent", () => {
    expect(say({ estimate: { from: null, to: 3 } })).toEqual(["set the estimate to 3 pts"]);
    expect(say({ estimate: { from: 3, to: null } })).toEqual(["cleared the estimate"]);
    expect(say({ due_on: { from: null, to: "2026-12-01" } })).toEqual(["set the due date to Dec 1"]);
    expect(say({ due_on: { from: "2026-12-01", to: null } })).toEqual(["cleared the due date"]);
    expect(say({ parent_id: { from: null, to: "t9" } })).toEqual(["made this a sub-task of SVA-9"]);
    expect(say({ parent_id: { from: "t9", to: null } })).toEqual(["removed the parent task"]);
  });

  it("project, archive, trash, title and description", () => {
    expect(say({ project_id: { from: "p0", to: "p1" } }, { moved_from: "OPS-3" })).toEqual([
      "moved this here from OPS-3",
    ]);
    expect(say({ archived_at: { from: null, to: 5 } })).toEqual(["archived this"]);
    expect(say({ deleted_at: { from: null, to: 5 } })).toEqual(["moved this to the trash"]);
    expect(say({ title: { from: "a", to: "b" } })).toEqual(["renamed this from “a” to “b”"]);
  });

  it("says several in one fixed order, whatever order the change lists them in", () => {
    expect(
      say({
        due_on: { from: null, to: "2026-12-01" },
        parent_id: { from: null, to: "t9" },
        estimate: { from: null, to: 3 },
        cycle_id: { from: null, to: "c1" },
        milestone_id: { from: null, to: "m1" },
        epic_id: { from: null, to: "e1" },
        label_ids: { from: null, to: ["l1"] },
        priority: { from: null, to: 1 },
        budget: { from: null, to: { minutes: 5 } },
        waiting_on_id: { from: null, to: "u2" },
        assignee_id: { from: null, to: "u2" },
        status_id: { from: "s1", to: "s2" },
        description: { from: null, to: "x" },
        title: { from: "a", to: "b" },
      }),
    ).toEqual([
      "renamed this from “a” to “b”",
      "edited the description",
      "moved this from Todo to Doing",
      "assigned this to @coder",
      "asked @coder to act",
      "set the task's budget",
      "set the priority to Urgent",
      "added the label bug",
      "added this to the epic Launch",
      "set the milestone to Beta",
      "added this to Cycle 4",
      "set the estimate to 3 pts",
      "set the due date to Dec 1",
      "made this a sub-task of SVA-9",
    ]);
  });
});
