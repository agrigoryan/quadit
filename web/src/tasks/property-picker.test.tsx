// @vitest-environment jsdom
// The property picker (tasks/property-picker.tsx), kind by kind: the rows it
// offers for a task, the one it marks as picked, and the change a pick sends.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import type { Member, Task, User, Workspace } from "@/types/core";
import { PROPERTIES, type PropertyName } from "@/tasks/properties";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { TooltipProvider } from "@/ui/tooltip";

/** A change as the server receives it. */
type Sent = { type: string; args: Record<string, unknown> };

let sent: Sent[] = [];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  project_id: "p1",
  number: 1,
  key: "SVA-1",
  title: "First",
  status_id: "s1",
  priority: 0,
  rank: "a",
  created_by: "u1",
  created_at: 0,
  updated_at: 0,
  updated_seq: 0,
  ...over,
});

beforeEach(() => {
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const changes = (body as { changes: Sent[] }).changes;
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  // What the agents are doing is asked for while a list of people is open; it never answers here.
  vi.spyOn(api, "get").mockReturnValue(new Promise(() => {}));
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Game", settings: { cycles: true } },
      { id: "p2", key: "OPS", name: "Ops" },
    ],
    statuses: [
      { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", is_default: true, rank: "a" },
      { id: "s2", project_id: "p1", name: "Doing", category: "started", rank: "b" },
      { id: "s9", project_id: "p2", name: "Open", category: "unstarted", rank: "a" },
    ],
    members: [
      { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" },
      { user_id: "u2", handle: "coder", name: "Coder", kind: "agent", role: "member" },
    ],
    labels: [
      { id: "l1", project_id: "p1", name: "bug" },
      { id: "l2", project_id: "p1", name: "art" },
    ],
    epics: [{ id: "e1", project_id: "p1", name: "Launch", rank: "a" }],
    milestones: [{ id: "m1", epic_id: "e1", name: "Beta", target_on: "2026-12-01", rank: "a" }],
    cycles: [{ id: "c1", project_id: "p1", number: 4, starts_on: "2026-11-02", ends_on: "2026-11-15" }],
    tasks: [task({ epic_id: "e1" })],
  });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

const theTask = () => getState().collections.tasks.t1 as Task;

function open(kind: PropertyName, tasks: Task[] = [theTask()]) {
  const property = PROPERTIES.find((p) => p.name === kind);
  const picker = property?.picker;
  if (!property || !picker) throw new Error(`${kind} has no picker`);
  render(
    <MemoryRouter>
      <TooltipProvider>
        <TaskPropertyPicker property={{ ...property, picker }} tasks={tasks} open onOpenChange={() => {}} />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const list = () => screen.getByRole("listbox");
/** Each row as "label · hint", with a ✓ after the one picked now. */
const rows = () =>
  within(list())
    .getAllByRole("option")
    .map((o) => {
      const label = o.querySelector("span.flex-1")?.textContent ?? "";
      const hint = o.querySelector("span.text-xs")?.textContent;
      return `${label}${hint ? ` · ${hint}` : ""}${o.querySelector("svg.lucide-check") ? " ✓" : ""}`;
    });
const pick = (name: string | RegExp) => fireEvent.click(within(list()).getByRole("option", { name }));
const lastSent = async () => {
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  return sent.at(-1);
};

describe("TaskPropertyPicker", () => {
  it("status: the project's statuses, and the change of status", async () => {
    open("status");
    expect(screen.getByRole("dialog", { name: "Change status…" })).toBeInTheDocument();
    expect(rows()).toEqual(["Todo ✓", "Doing", "Manage statuses"]);
    pick("Doing");
    expect(await lastSent()).toEqual({ type: "task.update", args: { id: "t1", status: "s2" } });
  });

  it("assignee: unassigned, then me first, then the rest; picks a person", async () => {
    open("assignee");
    expect(screen.getByRole("dialog", { name: "Assign to…" })).toBeInTheDocument();
    expect(rows()).toEqual(["Unassigned ✓", "Ann", "Coder · Agent"]);
    pick(/Coder/);
    expect(await lastSent()).toEqual({ type: "task.update", args: { id: "t1", assignee: "u2" } });
  });

  it("waiting: nobody, an outside event, then the people; an outside event asks for a note", async () => {
    open("waiting");
    expect(screen.getByRole("dialog", { name: "Wait on…" })).toBeInTheDocument();
    expect(rows()).toEqual(["Nobody ✓", "An outside event…", "Ann", "Coder · Agent"]);
    pick("An outside event…");
    fireEvent.change(screen.getByLabelText("What is it waiting for?"), { target: { value: " the review " } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(await lastSent()).toEqual({
      type: "task.update",
      args: { id: "t1", waiting_on: "outside", waiting_on_note: "the review" },
    });
  });

  it("waiting: picks a person", async () => {
    open("waiting");
    pick(/Ann/);
    expect(await lastSent()).toEqual({
      type: "task.update",
      args: { id: "t1", waiting_on: "u1", waiting_on_note: "" },
    });
  });

  it("priority: every priority with its number, none first", async () => {
    open("priority");
    expect(screen.getByRole("dialog", { name: "Set priority…" })).toBeInTheDocument();
    expect(rows()).toEqual(["No priority · 0 ✓", "Urgent · 1", "High · 2", "Medium · 3", "Low · 4"]);
    pick(/High/);
    expect(await lastSent()).toEqual({ type: "task.update", args: { id: "t1", priority: 2 } });
  });

  it("labels: the project's labels; a pick adds one and the list stays open", async () => {
    open("label");
    expect(screen.getByRole("dialog", { name: "Add or remove labels…" })).toBeInTheDocument();
    expect(rows()).toEqual(["art", "bug", "Manage labels"]);
    pick("art");
    expect(await lastSent()).toEqual({ type: "task.update", args: { id: "t1", add_labels: ["l2"] } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("labels: a label every task has is taken off them all", async () => {
    open("label", [task({ label_ids: ["l1"] }), task({ id: "t2", key: "SVA-2", label_ids: ["l1"] })]);
    expect(rows()).toEqual(["art", "bug ✓", "Manage labels"]);
    pick("bug");
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { type: "task.update", args: { id: "t1", remove_labels: ["l1"] } },
      { type: "task.update", args: { id: "t2", remove_labels: ["l1"] } },
    ]);
  });

  it("epic: no epic, then the project's epics; clearing sends null", async () => {
    open("epic");
    expect(screen.getByRole("dialog", { name: "Set epic…" })).toBeInTheDocument();
    expect(rows()).toEqual(["No epic", "Launch ✓"]);
    pick("No epic");
    expect(await lastSent()).toEqual({ type: "task.update", args: { id: "t1", epic: null } });
  });

  it("milestone: no milestone, then the milestones of the task's epic with their day", async () => {
    open("milestone");
    expect(screen.getByRole("dialog", { name: "Set milestone…" })).toBeInTheDocument();
    expect(rows()).toEqual(["No milestone ✓", "Beta · Dec 1"]);
    pick(/Beta/);
    expect(await lastSent()).toEqual({ type: "task.update", args: { id: "t1", milestone: "m1" } });
  });

  it("cycle: no cycle, then the project's cycles with their days", async () => {
    open("cycle");
    expect(screen.getByRole("dialog", { name: "Set cycle…" })).toBeInTheDocument();
    expect(rows()).toEqual(["No cycle ✓", "Cycle 4 · Nov 2 – Nov 15"]);
    pick(/Cycle 4/);
    expect(await lastSent()).toEqual({ type: "task.update", args: { id: "t1", cycle: "c1" } });
  });

  it("project: every project with its key; moving sends task.move", async () => {
    open("project");
    expect(screen.getByRole("dialog", { name: "Move to project…" })).toBeInTheDocument();
    expect(rows()).toEqual(["Game · SVA ✓", "Ops · OPS"]);
    pick(/Ops/);
    expect(await lastSent()).toEqual({ type: "task.move", args: { id: "t1", project: "p2" } });
  });
});
