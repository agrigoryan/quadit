// @vitest-environment jsdom
// A page's Tasks panel (docs/page/tasks-panel.tsx): the tasks linked to the
// page, those that mention it and those it mentions, each once, each a link
// to the task with its key, status and assignee; a linked one can be taken
// off here, and a link made or taken off since the page was read shows at
// once. A task the copy does not hold (one this person may not see) is not
// listed.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap, mergeRows } from "@/data/store";
import { TasksPanel } from "@/docs/page/tasks-panel";
import { useDocsStore } from "@/docs/store";
import { WithQuery } from "@/test/query";
import type { Member, Task, TaskLink, User, Workspace } from "@/types/core";
import type { DocRef } from "@/types/docs";
import { TooltipProvider } from "@/ui/tooltip";

const task = (n: number, more: Partial<Task> = {}) =>
  ({ id: `t${n}`, key: `SVA-${n}`, project_id: "p1", status_id: "s1", title: `Task ${n}`, ...more }) as Task;
const ref = (fromType: string, fromId: string, scopeId: string, toType = "doc", to = "page"): DocRef => ({
  from_type: fromType,
  from_id: fromId,
  from_scope_type: "task",
  from_scope_id: scopeId,
  to_type: toType,
  to_id: to,
});

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const changes = (body as { changes: Sent[] }).changes;
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann Owner", role: "member", kind: "person" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    members: [{ user_id: "u1", handle: "ann", name: "Ann Owner", kind: "person" }],
    tasks: [task(1, { assignee_id: "u1" }), task(2), task(3), task(4), task(5, { deleted_at: 9 })],
    docs: [{ id: "page", title: "Handbook", kind: "page" }],
  });
  // What the page was read with: t1 linked, t2 mentioning it (and t9, a task this person cannot see), t3 named in it.
  useDocsStore.setState({
    meta: {
      page: {
        mentioned_in: [ref("link", "l1", "t1"), ref("comment", "c2", "t2"), ref("task", "t9", "t9")],
        mentions: [
          { ...ref("block", "b1", "page", "task", "t3"), from_scope_type: "doc" },
          ref("block", "b2", "page", "task", "t5"),
        ],
      },
    },
  });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

function show() {
  render(
    <MemoryRouter initialEntries={["/acme/docs/page"]}>
      <WithQuery>
        <TooltipProvider>
          <TasksPanel docId="page" />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
  return screen.getByRole("region", { name: "Tasks" });
}

const titles = () =>
  within(screen.getByRole("region", { name: "Tasks" }))
    .getAllByRole("listitem")
    .map((row) => within(row).getByRole("link").textContent);

describe("a page's Tasks", () => {
  it("lists linked tasks first, then those that mention the page and those it names, with key, status and assignee", () => {
    const panel = show();
    expect(titles()).toEqual(["Task 1", "Task 2", "Task 3"]);
    const first = within(panel).getAllByRole("listitem")[0] as HTMLElement;
    expect(within(first).getByText("SVA-1")).toBeInTheDocument();
    expect(within(first).getByRole("img", { name: "Todo" })).toBeInTheDocument();
    expect(within(first).getByTitle("Ann Owner")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Task 1" })).toHaveAttribute("href", "/acme/task/SVA-1");
    expect(within(panel).getByText("mentions this page")).toBeInTheDocument();
    expect(within(panel).getByText("mentioned here")).toBeInTheDocument();
    expect(within(panel).getAllByRole("button", { name: /^Remove the link/ })).toHaveLength(1);
  });

  it("takes a link off, and the page forgets it once the server has", async () => {
    const panel = show();
    fireEvent.click(within(panel).getByRole("button", { name: "Remove the link to SVA-1" }));
    await waitFor(() => expect(sent).toEqual([{ type: "link.remove", args: { id: "l1" } }]));
    await waitFor(() => expect(titles()).toEqual(["Task 2", "Task 3"]));
    expect(useDocsStore.getState().meta.page?.mentioned_in.map((r) => r.from_id)).toEqual(["c2", "t9"]);
  });

  it("shows a link made since the page was read, and drops one taken off", () => {
    show();
    const made = { id: "l4", task_id: "t4", kind: "doc", ref: "page" } as TaskLink;
    const gone = { id: "l1", task_id: "t1", kind: "doc", ref: "page", deleted_at: 5 } as TaskLink;
    mergeRows("links", [made, gone]);
    return waitFor(() => expect(titles()).toEqual(["Task 4", "Task 2", "Task 3"]));
  });
});
