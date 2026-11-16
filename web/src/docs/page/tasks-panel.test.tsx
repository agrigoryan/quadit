// @vitest-environment jsdom
// A page's Tasks panel (docs/page/tasks-panel.tsx): the tasks linked to the
// page, those that mention it and those it mentions, each once, each a link
// to the task with its key, status and assignee; a linked one can be taken
// off here, and a link made or taken off since the page was read shows at
// once. A task the copy does not hold (one this person may not see) is not
// listed.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { applyEvents, clearStore, loadBootstrap, mergeRows, useStore } from "@/data/store";
import { TasksPanel } from "@/docs/page/tasks-panel";
import { useDocsStore } from "@/docs/store";
import { WithQuery } from "@/test/query";
import type { FeedEvent, Member, Task, TaskLink, User, Workspace } from "@/types/core";
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
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    // Ann is kept to SVA: a task of OPS is not one she may change, should the copy hold one.
    me: {
      user_id: "u1",
      handle: "ann",
      name: "Ann Owner",
      role: "member",
      kind: "person",
      scope: { projects: ["p1"] },
    } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Game" },
      { id: "p2", key: "OPS", name: "Ops" },
    ],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    members: [{ user_id: "u1", handle: "ann", name: "Ann Owner", kind: "person" }],
    tasks: [
      task(1, { assignee_id: "u1" }),
      task(2),
      task(3),
      task(4),
      task(5, { deleted_at: 9 }),
      task(6, { project_id: "p2", key: "OPS-6" }),
    ],
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

function renderPanel() {
  render(
    <MemoryRouter initialEntries={["/acme/docs/page"]}>
      <WithQuery>
        <TooltipProvider>
          <TasksPanel docId="page" />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

function show() {
  renderPanel();
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

  it("follows the feed: a link someone else takes off goes, though its task was never opened here, and one made comes", async () => {
    show();
    const linkEvent = (seq: number, type: string, data: FeedEvent["data"]): FeedEvent =>
      ({
        seq,
        at: 1,
        type,
        entity_type: "link",
        entity_id: `l${seq}`,
        scope_type: "task",
        scope_id: "t1",
        data,
      }) as FeedEvent;
    act(() =>
      applyEvents(
        [
          {
            ...linkEvent(2, "link.deleted", { id: "l1", changes: { deleted_at: { from: null, to: 5 } } }),
            entity_id: "l1",
          },
          linkEvent(3, "link.created", { row: { id: "l3", task_id: "t4", kind: "doc", ref: "page" } }),
        ],
        true,
      ),
    );
    await waitFor(() => expect(titles()).toEqual(["Task 4", "Task 2", "Task 3"]));
  });

  it("links a task picked by key or title, offering only tasks not listed yet that this person may change", async () => {
    const panel = show();
    fireEvent.click(within(panel).getByRole("button", { name: "Add a task" }));
    const list = await screen.findByRole("listbox", { name: "Add a task" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Task 4SVA-4"]);
    fireEvent.change(screen.getByPlaceholderText("Add a task"), { target: { value: "sva-4" } });
    fireEvent.click(within(list).getByRole("option", { name: /Task 4/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: "link.set", args: { task: "t4", kind: "doc", ref: "page" } });
    await waitFor(() => expect(titles()).toEqual(["Task 4", "Task 1", "Task 2", "Task 3"]));
  });

  it("is there to add the first task", () => {
    useDocsStore.setState({ meta: {} });
    const panel = show();
    expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(panel).getByRole("button", { name: "Add a task" })).toBeInTheDocument();
  });

  it("draws nothing for someone who may change no task, when no task points at the page", () => {
    useDocsStore.setState({ meta: {} });
    useStore.setState((s) => ({ me: s.me && { ...s.me, scope: { read_only: true } } }));
    renderPanel();
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
  });
});
