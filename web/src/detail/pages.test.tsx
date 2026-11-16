// @vitest-environment jsdom
// A task's Pages section (detail/pages.tsx): the pages linked to the task,
// those that mention it and those it mentions, each once and each a link to
// the page; a linked one can be taken off, and "Add a page" links another,
// found by its title, of the pages this person may see.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { queryClient } from "@/data/query";
import { getRowEvenIfGone } from "@/data/selectors";
import { clearStore, loadBootstrap } from "@/data/store";
import { taskKeys } from "@/data/task-detail";
import { Pages, useTaskPages } from "@/detail/pages";
import { WithQuery } from "@/test/query";
import type { Member, Task, TaskLink, User, Workspace } from "@/types/core";
import type { DocRef } from "@/types/docs";
import { TooltipProvider } from "@/ui/tooltip";

const task = { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Boss design" } as Task;
const link = (id: string, ref: string): TaskLink => ({
  id,
  task_id: "t1",
  kind: "doc",
  ref,
  created_by: "u1",
  created_at: 0,
  updated_at: 0,
  updated_seq: 0,
});
const ref = (from: string, scope: "task" | "doc", scopeId: string, toType: string, to: string): DocRef => ({
  from_type: from,
  from_id: scopeId,
  from_scope_type: scope,
  from_scope_id: scopeId,
  to_type: toType,
  to_id: to,
});

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

function load(readOnly: boolean, links: TaskLink[]) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: {
      user_id: "u1",
      handle: "ann",
      name: "Ann",
      role: "member",
      kind: "person",
      scope: { read_only: readOnly },
    } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    tasks: [task],
    links,
    docs: [
      { id: "art", title: "Art guide", kind: "page" },
      { id: "plan", title: "Boss plan", kind: "page" },
      { id: "notes", title: "Meeting notes", kind: "page" },
      { id: "spec", title: "Spec", kind: "page" },
      { id: "gone", title: "Old page", kind: "page", deleted_at: 5 },
      { id: "row1", title: "A row", kind: "row", parent_id: "db" },
    ],
  });
  // What came with the task's detail: who mentions it, and what it mentions.
  queryClient.setQueryData(taskKeys.detail("acme", "t1"), {
    events: [],
    mentionedIn: [
      { ...ref("block", "doc", "plan", "task", "t1"), title: "Boss plan" },
      { ...ref("block", "doc", "art", "task", "t1"), title: "Art guide" },
    ],
    mentions: [
      ref("comment", "task", "t1", "doc", "notes"),
      ref("task", "task", "t1", "doc", "gone"),
      { ...ref("link", "task", "t1", "doc", "art"), from_id: "l1" },
    ],
  });
}

beforeAll(() => {
  // cmdk scrolls the active row into view and measures the list; jsdom does neither.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const changes = (body as { changes: Sent[] }).changes;
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
});

afterEach(async () => {
  await clearOutbox();
  queryClient.clear();
  vi.restoreAllMocks();
});

function Section() {
  return <Pages task={task} pages={useTaskPages(task.id)} />;
}

function show() {
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <Section />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
  return screen.getByRole("region", { name: "Pages" });
}

describe("a task's Pages", () => {
  it("lists linked pages first, then those that mention the task and those it mentions, each once", () => {
    load(false, [link("l1", "art")]);
    const section = show();
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual([
      "Art guide",
      "Boss plan",
      "Meeting notes",
    ]);
    expect(within(section).getByRole("link", { name: "Boss plan" })).toHaveAttribute("href", "/acme/docs/plan");
    expect(within(rows[1] as HTMLElement).getByText("mentions this task")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("mentioned here")).toBeInTheDocument();
    // Only a link can be taken off: a mention is in the text.
    expect(within(section).getAllByRole("button", { name: /^Remove the link/ })).toHaveLength(1);
  });

  it("takes a linked page off", async () => {
    load(false, [link("l1", "art")]);
    const section = show();
    fireEvent.click(within(section).getByRole("button", { name: "Remove the link to Art guide" }));
    await waitFor(() => expect(sent).toEqual([{ type: "link.remove", args: { id: "l1" } }]));
    expect(getRowEvenIfGone("links", "l1")?.deleted_at).toBeTruthy();
    // Still mentioned by the page, it stays, as a mention.
    expect(within(screen.getByRole("region", { name: "Pages" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("links a page picked by its title, offering only pages not listed yet and not a database's rows", async () => {
    load(false, [link("l1", "art")]);
    const section = show();
    fireEvent.click(within(section).getByRole("button", { name: "Add a page" }));
    const list = await screen.findByRole("listbox", { name: "Add a page" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Spec"]);
    fireEvent.change(screen.getByPlaceholderText("Search pages by title"), { target: { value: "spe" } });
    fireEvent.click(within(list).getByRole("option", { name: "Spec" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: "link.set", args: { task: "t1", kind: "doc", ref: "spec" } });
    expect(within(screen.getByRole("region", { name: "Pages" })).getByRole("link", { name: "Spec" })).toBeTruthy();
  });

  it("offers neither adding nor taking off to someone who may not change the task", () => {
    load(true, [link("l1", "art")]);
    const section = show();
    expect(within(section).getByRole("link", { name: "Art guide" })).toBeInTheDocument();
    expect(within(section).queryByRole("button")).not.toBeInTheDocument();
  });
});
