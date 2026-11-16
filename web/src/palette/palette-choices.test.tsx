// @vitest-environment jsdom
// Changing the open task from the command palette (palette/palette-choices.tsx
// and the task's commands in palette/palette-commands.tsx): the commands with
// their keys, the values each offers, and the change a choice sends.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, Project, Task, User, Workspace } from "@/types/core";
import { ui } from "@/lib/ui-state";
import { CommandPalette } from "@/palette/palette";
import { ShortcutsSheet } from "@/palette/shortcuts";
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

const task = (n: number, fields: Partial<Task> = {}) =>
  ({ id: `t${n}`, project_id: "p1", number: n, key: `SVA-${n}`, status_id: "s1", rank: String(n), ...fields }) as Task;

function seed(scope?: Member["scope"], first: Partial<Task> = {}, settings?: Project["settings"]) {
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "member", scope } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Game", settings },
      { id: "p2", key: "OPS", name: "Ops" },
    ],
    statuses: [
      { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
      { id: "s2", project_id: "p1", name: "Doing", category: "started", rank: "b" },
    ],
    members: [
      { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "member" },
      { user_id: "u2", handle: "coder", name: "Coder", kind: "agent", role: "member" },
      { user_id: "u3", handle: "old", name: "Old", kind: "agent", role: "member", suspended_at: 5 },
    ],
    labels: [{ id: "l1", project_id: "p1", name: "bug" }],
    epics: [{ id: "e1", project_id: "p1", name: "Launch", rank: "a" }],
    milestones: [{ id: "m1", epic_id: "e1", name: "Beta", rank: "a" }],
    cycles: [{ id: "c1", project_id: "p1", number: 4, starts_on: "2026-11-01", ends_on: "2026-11-14" }],
    tasks: [
      task(1, { title: "First", priority: 3, ...first }),
      task(2, { title: "Second", updated_at: 2 }),
      // Under the first: not a parent it can be put under.
      task(3, { title: "Third", parent_id: "t1" }),
      task(4, { title: "Elsewhere", project_id: "p2", key: "OPS-4" }),
    ],
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
  act(() => ui.setPalette(false));
  vi.restoreAllMocks();
});

function openPalette() {
  act(() => ui.setPalette(true));
  render(
    <MemoryRouter initialEntries={["/acme/task/SVA-1"]}>
      <TooltipProvider>
        <CommandPalette />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

/** Each row as "label detail [key]", with a ✓ after the one in effect. */
const rows = () =>
  within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((o) => {
      const label = o.querySelector("span.shrink")?.textContent ?? "";
      const detail = o.querySelector("span.flex-1")?.textContent;
      const key = Array.from(o.querySelectorAll("kbd"), (cap) => cap.textContent).join(" ");
      return (
        [label, detail, key && `[${key}]`].filter(Boolean).join(" ") + (o.querySelector("svg.lucide-check") ? " ✓" : "")
      );
    });
const choose = (name: RegExp) => fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name }));

describe("the palette on a task", () => {
  it("offers to change what it is filed under, each with its key, and to watch it", () => {
    seed();
    openPalette();
    expect(rows().slice(0, 12)).toEqual([
      "Change status… [S]",
      "Assign to… [A]",
      "Set priority… [P]",
      "Add or remove labels… [L]",
      "Set epic… [Shift P]",
      "Set parent task…",
      "Move to project…",
      "Watch this task [Shift S]",
      "Copy key [Ctrl .]",
      "Copy link [Shift Ctrl ,]",
      "Copy git branch name [Shift Ctrl .]",
      expect.stringMatching(/^New task/),
    ]);
  });

  it("offers the milestone in an epic, and the cycle where the project has cycles", () => {
    seed(undefined, { epic_id: "e1" }, { cycles: true });
    openPalette();
    expect(rows().slice(4, 9)).toEqual([
      "Set epic… [Shift P]",
      "Set milestone… [Shift M]",
      "Set cycle… [Shift C]",
      "Set parent task…",
      "Move to project…",
    ]);
  });

  it("offers nothing to change to a read-only member, nor to watch", () => {
    seed({ read_only: true });
    openPalette();
    expect(screen.queryByRole("option", { name: /Change status/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Watch/ })).toBeNull();
  });

  it("watch: watches the task, and then offers to stop", async () => {
    seed();
    openPalette();
    choose(/Watch this task/);
    await waitFor(() => expect(sent).toEqual([{ type: "watch.set", args: { subject: "t1", watching: true } }]));
    act(() => ui.setPalette(true));
    expect(screen.getByRole("option", { name: /Stop watching/ })).toBeInTheDocument();
  });

  it("epic: no epic, then the project's epics", async () => {
    seed();
    openPalette();
    choose(/Set epic/);
    expect(rows()).toEqual(["No epic ✓", "Launch"]);
    choose(/Launch/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", epic: "e1" } }]));
  });

  it("milestone: no milestone, then the epic's milestones", async () => {
    seed(undefined, { epic_id: "e1" });
    openPalette();
    choose(/Set milestone/);
    expect(rows()).toEqual(["No milestone ✓", "Beta"]);
    choose(/Beta/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", milestone: "m1" } }]));
  });

  it("cycle: no cycle, then the project's cycles with their days", async () => {
    seed(undefined, {}, { cycles: true });
    openPalette();
    choose(/Set cycle/);
    expect(rows()).toEqual(["No cycle ✓", expect.stringMatching(/^Cycle 4 Nov 1/)]);
    choose(/Cycle 4/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", cycle: "c1" } }]));
  });

  it("parent: no parent, then the project's tasks it can go under, by key too", async () => {
    seed();
    openPalette();
    choose(/Set parent/);
    expect(rows()).toEqual(["No parent ✓", "Second SVA-2"]);
    fireEvent.change(screen.getByPlaceholderText("Set parent task…"), { target: { value: "SVA-2" } });
    choose(/Second/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", parent: "t2" } }]));
  });

  it("project: every project, this one checked, and a move to another", async () => {
    seed();
    openPalette();
    choose(/Move to project/);
    expect(rows()).toEqual(["Game SVA ✓", "Ops OPS"]);
    choose(/Ops/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.move", args: { id: "t1", project: "p2" } }]));
  });

  it("status: the project's statuses, the one in effect checked", async () => {
    seed();
    openPalette();
    choose(/Change status/);
    expect(screen.getByPlaceholderText("Change status…")).toBeInTheDocument();
    expect(rows()).toEqual(["Todo ✓", "Doing"]);
    choose(/Doing/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", status: "s2" } }]));
  });

  it("assignee: unassigned, me first, people by handle, a suspended agent left out", async () => {
    seed();
    openPalette();
    choose(/Assign to/);
    expect(rows()).toEqual(["Unassigned ✓", "Ann @ann", "Coder @coder"]);
    choose(/Coder/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", assignee: "u2" } }]));
  });

  it("priority: urgent first and none last", async () => {
    seed();
    openPalette();
    choose(/Set priority/);
    expect(rows()).toEqual(["Urgent", "High", "Medium ✓", "Low", "No priority"]);
    choose(/Urgent/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", priority: 1 } }]));
  });

  it("labels: the project's labels, and one made from what is typed", async () => {
    seed();
    openPalette();
    choose(/Add or remove labels/);
    expect(rows()).toEqual(["bug"]);
    choose(/bug/);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", add_labels: ["l1"] } }]));
  });
});

describe("the shortcuts sheet", () => {
  it("lists S, A, P, L and the Shift keys of the task properties for lists and for the open task", () => {
    act(() => ui.setShortcuts(true));
    render(
      <TooltipProvider>
        <ShortcutsSheet />
      </TooltipProvider>,
    );
    const keysOf = (heading: string) => {
      const section = screen.getByRole("heading", { name: heading }).closest("section");
      if (!section) throw new Error(heading);
      return within(section)
        .getAllByRole("term")
        .map((dt) => `${dt.textContent} ${dt.nextElementSibling?.textContent}`)
        .filter((row) => /^Change/.test(row));
    };
    expect(keysOf("Lists")).toEqual([
      "Change status S",
      "Change assignee A",
      "Change priority P",
      "Change labels L",
      "Change epic ShiftP",
      "Change milestone, in an epic ShiftM",
      "Change cycle, where the project has cycles ShiftC",
      "Change estimate, where the project counts them ShiftE",
      "Change due date ShiftD",
    ]);
    expect(keysOf("A task")).toEqual(keysOf("Lists"));
    act(() => ui.setShortcuts(false));
  });
});
