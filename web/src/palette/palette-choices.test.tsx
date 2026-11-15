// @vitest-environment jsdom
// Changing the open task from the command palette (palette/palette-choices.tsx
// and the task's commands in palette/palette-commands.tsx): the commands with
// their keys, the values each offers, and the change a choice sends.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import { api } from "@/lib/api";
import { clearOutbox } from "@/lib/mutate";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/lib/types";
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

function seed(scope?: Member["scope"]) {
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "member", scope } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
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
    tasks: [
      {
        id: "t1",
        project_id: "p1",
        number: 1,
        key: "SVA-1",
        title: "First",
        status_id: "s1",
        priority: 3,
        rank: "a",
      },
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
      const key = o.querySelector("kbd")?.textContent;
      return (
        [label, detail, key && `[${key}]`].filter(Boolean).join(" ") + (o.querySelector("svg.lucide-check") ? " ✓" : "")
      );
    });
const choose = (name: RegExp) => fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name }));

describe("the palette on a task", () => {
  it("offers to change its status, assignee, priority and labels, each with its key", () => {
    seed();
    openPalette();
    expect(rows().slice(0, 7)).toEqual([
      "Change status… [S]",
      "Assign to… [A]",
      "Set priority… [P]",
      "Add or remove labels… [L]",
      "Copy key",
      "Copy link",
      expect.stringMatching(/^New task/),
    ]);
  });

  it("offers nothing to change to a read-only member", () => {
    seed({ read_only: true });
    openPalette();
    expect(screen.queryByRole("option", { name: /Change status/ })).toBeNull();
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
  it("lists S, A, P and L for lists and for the open task", () => {
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
    expect(keysOf("Lists")).toEqual(["Change status S", "Change assignee A", "Change priority P", "Change labels L"]);
    expect(keysOf("A task")).toEqual(keysOf("Lists"));
    act(() => ui.setShortcuts(false));
  });
});
