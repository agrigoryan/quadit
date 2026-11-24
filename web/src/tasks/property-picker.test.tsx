// @vitest-environment jsdom
// The property picker (tasks/property-picker.tsx), kind by kind: the rows it
// offers for a task, the one it marks as picked, and the change a pick sends.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { applyEvents, clearStore, getState, loadBootstrap } from "@/data/store";
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
  created_seq: 0,
  updated_seq: 0,
  activity_seq: 0,
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
      { user_id: "u3", handle: "opsbot", name: "Ops bot", kind: "agent", role: "member", scope: { projects: ["p2"] } },
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

  it("assignee and waiting: only those who may read the task's project", () => {
    open("assignee", [task({ id: "t2", project_id: "p2", key: "OPS-1", status_id: "s9" })]);
    expect(rows()).toEqual(["Unassigned ✓", "Ann", "Coder · Agent", "Ops bot · Agent"]);
    cleanup();
    open("waiting");
    expect(rows()).toEqual(["Nobody ✓", "An outside event…", "Ann", "Coder · Agent"]);
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

describe("whether an agent listens, beside it in a task's people pickers", () => {
  /** @coder listens to OPS only. */
  beforeEach(() => {
    vi.spyOn(api, "get").mockResolvedValue({
      agents: [
        {
          user_id: "u2",
          handle: "@coder",
          listening: true,
          listeners: [{ project_id: "p2", project: "OPS", by: "a chat", live: true }],
          listening_projects: ["p2"],
          listening_outside_projects: false,
        },
      ],
    });
  });

  const coder = () => within(list()).getByRole("option", { name: /Coder/ });

  it("marks whether it listens to the task's project", async () => {
    open("assignee");
    expect(await within(coder()).findByRole("img", { name: "Nothing is listening" })).toBeInTheDocument();
  });

  it("marks nothing for tasks of several projects, where no one answer is true", async () => {
    open("assignee", [theTask(), task({ id: "t2", project_id: "p2", key: "OPS-1" })]);
    // The answer is in once the single-project picker would show it.
    await waitFor(() => expect(vi.mocked(api.get)).toHaveBeenCalled());
    await act(() => new Promise((done) => setTimeout(done, 0)));
    expect(within(coder()).queryByRole("img")).toBeNull();
  });
});

describe("what assigning a task does, for an agent a computer runs", () => {
  /** Quadit runs @coder for SVA; the run outlook answers `outcome` for it, and asks are counted. */
  function serve(outlook: Record<string, string>) {
    const asked: string[] = [];
    vi.spyOn(api, "get").mockImplementation((path: string) => {
      asked.push(path);
      if (path.includes("/run-outlook"))
        return Promise.resolve({
          outlooks: [
            {
              agent: "@coder",
              machine: "Aram's MacBook Pro",
              folder: "~/devel/game",
              program: "claude",
              project: "SVA",
              owner: "@ann",
              since: "",
              until: "",
              running: "",
              reason: "",
              ...outlook,
            },
          ],
        });
      return Promise.resolve({
        agents: [
          {
            user_id: "u2",
            handle: "@coder",
            listening: true,
            listening_projects: ["p1"],
            listening_outside_projects: false,
            listeners: [
              {
                project_id: "p1",
                project: "SVA",
                live: true,
                runner: {
                  machine: "Aram's MacBook Pro",
                  folder: "~/devel/game",
                  program: "claude",
                  program_version: "2",
                  holding: true,
                  since: "",
                },
              },
            ],
          },
        ],
      });
    });
    return asked;
  }

  const coder = () => within(list()).getByRole("option", { name: /Coder/ });

  it.each([
    [{ outcome: "starts_now" }, "Starts now on Aram's MacBook Pro"],
    [{ outcome: "when_back" }, "Starts when Aram's MacBook Pro is back"],
    [{ outcome: "queued", running: "SVA-9" }, "Busy on Aram's MacBook Pro: queued"],
    [{ outcome: "paused", reason: "not_signed_in" }, "Paused on Aram's MacBook Pro"],
    [{ outcome: "will_not_start", reason: "not_responsible" }, "Will not start: only Ann's words start it"],
    [{ outcome: "will_not_start", reason: "no_runner_here" }, "Not run by Quadit for SVA"],
  ])("%o: says it under the agent", async (outlook, words) => {
    const asked = serve(outlook);
    open("assignee");
    expect(await within(coder()).findByText(words)).toBeInTheDocument();
    expect(asked).toContain(
      `/api/v1/w/acme/tasks/SVA-1/run-outlook?agents=${encodeURIComponent("@coder")}&cause=assign`,
    );
  });

  it("says nothing when assigning would start nothing", async () => {
    const asked = serve({ outcome: "none" });
    open("assignee");
    await waitFor(() => expect(asked.some((path) => path.includes("/run-outlook"))).toBe(true));
    await act(() => new Promise((done) => setTimeout(done, 0)));
    expect(within(coder()).queryByText(/^(Starts|Busy|Paused|Will not|Not run)/)).toBeNull();
  });

  it("says nothing for the agent that has the task already, without asking", async () => {
    const asked = serve({ outcome: "starts_now" });
    open("assignee", [task({ assignee_id: "u2" })]);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    await act(() => new Promise((done) => setTimeout(done, 0)));
    expect(asked.some((path) => path.includes("/run-outlook"))).toBe(false);
    expect(within(coder()).queryByText(/Starts now/)).toBeNull();
  });

  it("asks again when the task changes, as when someone else assigns it", async () => {
    const asked = serve({ outcome: "starts_now" });
    open("assignee");
    expect(await within(coder()).findByText("Starts now on Aram's MacBook Pro")).toBeInTheDocument();
    const before = asked.filter((path) => path.includes("/run-outlook")).length;
    act(() =>
      applyEvents(
        [
          {
            seq: 2,
            at: 2,
            actor_id: "u3",
            change_id: "c2",
            type: "task.updated",
            entity_type: "task",
            entity_id: "t1",
            scope_type: "",
            scope_id: "",
            data: { changes: { assignee_id: { from: null, to: "u3" } } },
          },
        ],
        true,
      ),
    );
    await waitFor(() => expect(asked.filter((path) => path.includes("/run-outlook")).length).toBeGreaterThan(before), {
      timeout: 4000,
    });
  });

  it("asks nothing for several tasks at once", async () => {
    const asked = serve({ outcome: "starts_now" });
    open("assignee", [theTask(), task({ id: "t2", key: "SVA-2" })]);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    await act(() => new Promise((done) => setTimeout(done, 0)));
    expect(asked.some((path) => path.includes("/run-outlook"))).toBe(false);
    expect(within(coder()).queryByText(/Starts now/)).toBeNull();
  });
});
