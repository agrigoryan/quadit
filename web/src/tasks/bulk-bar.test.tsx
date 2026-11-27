// @vitest-environment jsdom
// The bulk bar (tasks/bulk-bar.tsx): what it offers for a selection, as
// buttons and in its More menu, what a project without cycles or estimates
// leaves out, the pickers of a due date and an estimate, and a read-only
// member's selection with every control off.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, Project, Task, User, Workspace } from "@/types/core";
import { BulkBar } from "@/tasks/bulk-bar";
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

const task = (n: number): Task => ({
  id: `t${n}`,
  project_id: "p1",
  number: n,
  key: `SVA-${n}`,
  title: `Task ${n}`,
  status_id: "s1",
  priority: 0,
  rank: String(n),
  created_by: "u1",
  created_at: 0,
  updated_at: 0,
  created_seq: 0,
  updated_seq: 0,
  activity_seq: 0,
});
const TASKS = [task(1), task(2), task(3)];

function seed(settings: Project["settings"], scope?: Member["scope"]) {
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner", scope } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", settings }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    members: [{ user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" }],
    tasks: TASKS,
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

function renderBar() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <BulkBar tasks={TASKS} onClear={() => {}} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const bar = () => screen.getByRole("toolbar", { name: "3 selected" });
const buttons = () =>
  within(bar())
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));
const openMore = () => {
  const more = within(bar()).getByRole("button", { name: "More changes" });
  // Radix opens a menu on a pointer press jsdom does not make; a key opens it as well.
  fireEvent.keyDown(more, { key: "ArrowDown" });
};
const menu = () =>
  within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((m) => m.textContent);

describe("BulkBar", () => {
  it("offers status, assignee, priority and labels, then more, trash and clear", () => {
    seed({ cycles: true, estimates: true });
    renderBar();
    expect(buttons()).toEqual([
      "Status",
      "Assignee",
      "Priority",
      "Labels",
      "More changes",
      "Move to trash",
      "Clear selection",
    ]);
  });

  it("has epic, cycle, due date, estimate and moving in its More menu", () => {
    seed({ cycles: true, estimates: true });
    renderBar();
    openMore();
    expect(menu()).toEqual(["Set epic…", "Set cycle…", "Set due date…", "Set estimate…", "Move to project…"]);
  });

  it("leaves out cycles where the project has none, and estimates where they are turned off", () => {
    seed({ estimates: false });
    renderBar();
    openMore();
    expect(menu()).toEqual(["Set epic…", "Set due date…", "Move to project…"]);
  });

  it("leaves out estimates where the project says nothing of them: the server never says false, so that is off", () => {
    seed(undefined);
    renderBar();
    openMore();
    expect(menu()).toEqual(["Set epic…", "Set due date…", "Move to project…"]);
  });

  it("opens the status picker for the selection from its button", () => {
    seed({});
    renderBar();
    fireEvent.click(within(bar()).getByRole("button", { name: "Status" }));
    expect(screen.getByRole("dialog", { name: "Change status…" })).toBeInTheDocument();
  });

  it("sets one due date on every task", async () => {
    seed({});
    renderBar();
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Set due date…" }));
    const dialog = screen.getByRole("dialog", { name: "Set due date…" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Due date for 3 tasks" }), {
      target: { value: "dec 1 2026" },
    });
    fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "Due date for 3 tasks" }), { key: "Enter" });
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((c) => c.args)).toEqual([
      { id: "t1", due_on: "2026-12-01" },
      { id: "t2", due_on: "2026-12-01" },
      { id: "t3", due_on: "2026-12-01" },
    ]);
  });

  it("sets one estimate on every task", async () => {
    seed({ estimates: true });
    renderBar();
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Set estimate…" }));
    const dialog = screen.getByRole("dialog", { name: "Set estimate…" });
    fireEvent.change(within(dialog).getByLabelText("Estimate, in points, for 3 tasks"), { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[0]?.args).toEqual({ id: "t1", estimate: 5 });
  });

  it("sets one estimate on every task from the project's scale, a T-shirt size by its name", async () => {
    seed({ estimates: true, estimate_scale: "tshirt" });
    renderBar();
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Set estimate…" }));
    const dialog = screen.getByRole("dialog", { name: "Set estimate…" });
    fireEvent.click(within(dialog).getByRole("option", { name: /^XL/ }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((s) => s.args)).toEqual([
      { id: "t1", estimate: 8 },
      { id: "t2", estimate: 8 },
      { id: "t3", estimate: 8 },
    ]);
  });

  it("turns every change off for a read-only member", () => {
    seed({}, { read_only: true });
    renderBar();
    for (const name of ["Status", "Assignee", "Priority", "Labels", "More changes", "Move to trash"])
      expect(within(bar()).getByRole("button", { name })).toBeDisabled();
    expect(within(bar()).getByRole("button", { name: "Clear selection" })).toBeEnabled();
  });
});
