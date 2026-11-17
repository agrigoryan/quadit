// @vitest-environment jsdom
// The task's property panel (detail/properties.tsx): its rows in their
// order, those shown only where the project or the task has them, the S, A,
// P and L keys, a change made from a row, and a read-only member's rows.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import { Properties } from "@/detail/properties";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import type { Member, Project, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

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

const TASK: Task = {
  id: "t1",
  project_id: "p1",
  number: 1,
  key: "SVA-1",
  title: "First",
  status_id: "s1",
  priority: 2,
  label_ids: ["l1"],
  rank: "a",
  created_by: "u1",
  created_at: 0,
  updated_at: 0,
  created_seq: 0,
  updated_seq: 0,
  activity_seq: 0,
};

function seed({
  settings,
  role = "owner",
  scope,
  task = {},
}: { settings?: Project["settings"]; role?: Member["role"]; scope?: Member["scope"]; task?: Partial<Task> } = {}) {
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role, scope } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", settings }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    members: [{ user_id: "u1", handle: "ann", name: "Ann", kind: "person", role }],
    labels: [{ id: "l1", project_id: "p1", name: "bug" }],
    epics: [{ id: "e1", project_id: "p1", name: "Launch", rank: "a" }],
    tasks: [{ ...TASK, ...task }],
  });
}

beforeEach(() => {
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const changes = (body as { changes: Sent[] }).changes;
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  vi.spyOn(api, "get").mockReturnValue(new Promise(() => {}));
  clearStore();
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

function renderPanel() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Properties task={getState().collections.tasks.t1 as Task} />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const section = () => screen.getByRole("region", { name: "Properties" });
const rowNames = () =>
  within(section())
    .getAllByRole("term")
    .map((dt) => dt.textContent);
const press = (key: string) => act(() => void fireEvent.keyDown(document.body, { key }));
/** A letter with Shift, as the browser gives it: the capital, on the letter's key. */
const pressShift = (letter: string) =>
  act(
    () =>
      void fireEvent.keyDown(document.body, {
        key: letter.toUpperCase(),
        code: `Key${letter.toUpperCase()}`,
        shiftKey: true,
      }),
  );

describe("Properties", () => {
  it("shows the rows every task has, in order", () => {
    seed({ role: "member" });
    renderPanel();
    expect(rowNames()).toEqual([
      "Status",
      "Assignee",
      "Waiting on",
      "Priority",
      "Labels",
      "Epic",
      "Due date",
      "Parent",
    ]);
  });

  it("adds the milestone for a task in an epic, the cycle and estimate where the project has them, and the hand-off limit for an admin", () => {
    seed({ settings: { cycles: true, estimates: true }, task: { epic_id: "e1" } });
    renderPanel();
    expect(rowNames()).toEqual([
      "Status",
      "Assignee",
      "Waiting on",
      "Priority",
      "Labels",
      "Epic",
      "Milestone",
      "Cycle",
      "Estimate",
      "Due date",
      "Parent",
      "Hand-off limit",
    ]);
  });

  it("names each value on its button", () => {
    seed();
    renderPanel();
    for (const name of [
      "Status: Todo",
      "Assignee: Unassigned",
      "Waiting on: Nobody",
      "Priority: High",
      "Labels: bug",
      "Epic: No epic",
      "Parent: No parent",
    ])
      expect(within(section()).getByRole("button", { name })).toBeEnabled();
  });

  it.each([
    ["s", "Change status…"],
    ["a", "Assign to…"],
    ["p", "Set priority…"],
    ["l", "Add or remove labels…"],
  ])("opens a picker with %s", (key, title) => {
    seed();
    renderPanel();
    press(key);
    expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
  });

  it.each([
    ["p", "Set epic…"],
    ["m", "Set milestone…"],
    ["c", "Set cycle…"],
  ])("opens a picker with Shift+%s", (letter, title) => {
    seed({ settings: { cycles: true }, task: { epic_id: "e1" } });
    renderPanel();
    pressShift(letter);
    expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
  });

  it("puts the caret in the estimate with Shift+E, its value chosen, and in the due date with Shift+D", () => {
    seed({ settings: { estimates: true }, task: { estimate: 3 } });
    renderPanel();
    pressShift("e");
    const estimate = within(section()).getByLabelText<HTMLInputElement>("Estimate");
    expect(estimate).toHaveFocus();
    pressShift("d");
    expect(within(section()).getByLabelText("Due date")).toHaveFocus();
  });

  it("opens nothing with Shift+M outside an epic, Shift+C without cycles, Shift+E without estimates", () => {
    seed();
    renderPanel();
    for (const letter of ["m", "c", "e"]) pressShift(letter);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body).toHaveFocus();
  });

  it("changes the epic from its row", async () => {
    seed();
    renderPanel();
    fireEvent.click(within(section()).getByRole("button", { name: "Epic: No epic" }));
    fireEvent.click(screen.getByRole("option", { name: "Launch" }));
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", epic: "e1" } }]));
  });

  it("changes the due date from its field", async () => {
    seed();
    renderPanel();
    fireEvent.change(within(section()).getByLabelText("Due date"), { target: { value: "2026-12-01" } });
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", due_on: "2026-12-01" } }]));
  });

  it("sets the hand-off limit from its field", async () => {
    seed();
    renderPanel();
    const field = within(section()).getByLabelText("Hand-off limit");
    expect(field).toHaveAttribute("placeholder", "No limit");
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.blur(field);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", handoff_limit: 3 } }]));
  });

  it("clears the hand-off limit when its field is emptied", async () => {
    seed({ task: { handoff_limit: 2 } });
    renderPanel();
    const field = within(section()).getByLabelText("Hand-off limit");
    expect(field).toHaveValue(2);
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", handoff_limit: null } }]));
  });

  it("turns the rows off for a read-only member, and the keys open nothing", () => {
    seed({ role: "member", scope: { read_only: true } });
    renderPanel();
    for (const name of [
      "Status: Todo",
      "Assignee: Unassigned",
      "Waiting on: Nobody",
      "Priority: High",
      "Labels: bug",
      "Epic: No epic",
      "Parent: No parent",
    ])
      expect(within(section()).getByRole("button", { name })).toBeDisabled();
    expect(within(section()).getByLabelText("Due date")).toHaveAttribute("readonly");
    press("s");
    pressShift("p");
    pressShift("d");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body).toHaveFocus();
  });
});
