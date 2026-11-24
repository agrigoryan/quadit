// @vitest-environment jsdom
// A task handed back to me (detail/hand-back.tsx): shown when it waits on me
// and no question of mine is open on it, with who handed it and their note;
// Looks good stops the wait and offers to mark the task done; Reply puts
// the hand-back to whoever handed it in my comment box; Not waiting on me
// only stops the wait.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { queryClient } from "@/data/query";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { taskKeys } from "@/data/task-detail";
import { EMPTY_DRAFT, useDrafts } from "@/detail/comment-actions";
import { HandBack, handedBy } from "@/detail/hand-back";
import { WithQuery } from "@/test/query";
import type { Decision, FeedEvent, Member, Task, User, Workspace } from "@/types/core";

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

const ann = { user_id: "u1", handle: "ann", name: "Ann", role: "member", kind: "person" } as Member;
const coder = { user_id: "a1", handle: "coder", name: "Coder", role: "member", kind: "agent" } as Member;
const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    project_id: "p1",
    key: "SVA-53",
    title: "Make the boss harder",
    number: 53,
    rank: "a",
    status_id: "s1",
    waiting_on_id: "u1",
    waiting_on_note: "review the result",
    ...over,
  }) as Task;

/** The task's history: the agent handed it to Ann. */
const handOff: FeedEvent = {
  seq: 7,
  at: 7,
  actor_id: "a1",
  change_id: "c7",
  type: "task.updated",
  entity_type: "task",
  entity_id: "t1",
  scope_type: "",
  scope_id: "",
  data: { changes: { waiting_on_id: { from: null, to: "u1" } } },
};

function show(shown: Task, more: { me?: Member; decisions?: Decision[] } = {}) {
  cleanup();
  clearStore();
  const me = more.me ?? ann;
  loadBootstrap("acme", {
    seq: 10,
    me,
    user: { id: me.user_id } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", rank: "a" }],
    statuses: [
      { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
      { id: "s9", project_id: "p1", name: "Done", category: "done", rank: "z" },
    ],
    members: [ann, coder],
    tasks: [shown],
    decisions: more.decisions ?? [],
  });
  queryClient.setQueryData(taskKeys.detail("acme", "t1"), { events: [handOff] });
  render(
    <MemoryRouter>
      <HandBack task={getState().collections.tasks.t1 as Task} />
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const block = () => screen.queryByRole("region", { name: "Waiting on you" });

beforeEach(() => {
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: Sent[] };
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  useDrafts.setState({ drafts: {} });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

describe("the hand-back block", () => {
  it("says the task waits on me, who handed it, and what they said", () => {
    show(task());
    expect(within(block() as HTMLElement).getByText("@coder: review the result")).toBeTruthy();
  });

  it("is not there for a wait on someone else or outside, with a question of mine open, or for a reader", () => {
    show(task({ waiting_on_id: "a1" }));
    expect(block()).toBeNull();
    show(task({ waiting_on_id: undefined, waiting_outside: true }));
    expect(block()).toBeNull();
    show(task(), {
      decisions: [
        {
          id: "d1",
          task_id: "t1",
          kind: "choice",
          question: "Q",
          state: "open",
          asked_id: "u1",
          created_by: "a1",
          rank: "a",
        } as Decision,
      ],
    });
    expect(block()).toBeNull();
    show(task(), { me: { ...ann, scope: { read_only: true } } });
    expect(block()).toBeNull();
  });

  it("Looks good stops the wait, then offers to mark the task done", async () => {
    show(task());
    fireEvent.click(screen.getByRole("button", { name: "Looks good" }));
    await waitFor(() =>
      expect(sent).toEqual([{ type: "task.update", args: { id: "t1", waiting_on: null, waiting_on_note: "" } }]),
    );
    expect(block()).toBeNull();
    expect(screen.getByText("It no longer waits on you.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark SVA-53 done" }));
    await waitFor(() => expect(sent.at(-1)).toEqual({ type: "task.update", args: { id: "t1", status: "s9" } }));
    expect(screen.queryByRole("button", { name: "Mark SVA-53 done" })).toBeNull();
  });

  it("offers nothing more after Looks good on a task already done", async () => {
    show(task({ status_id: "s9" }));
    fireEvent.click(screen.getByRole("button", { name: "Looks good" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /^Mark/ })).toBeNull();
  });

  it("Reply hands the comment back to whoever handed the task", () => {
    show(task());
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(useDrafts.getState().drafts.t1).toEqual({ ...EMPTY_DRAFT, handTo: "a1" });
    expect(sent).toEqual([]);
  });

  it("Not waiting on me only stops the wait", async () => {
    show(task());
    fireEvent.click(screen.getByRole("button", { name: "Not waiting on me" }));
    await waitFor(() =>
      expect(sent).toEqual([{ type: "task.update", args: { id: "t1", waiting_on: null, waiting_on_note: "" } }]),
    );
    expect(screen.queryByText("It no longer waits on you.")).toBeNull();
  });
});

describe("handedBy", () => {
  it("names who last set the task to wait on someone", () => {
    const again = { ...handOff, seq: 9, actor_id: "u5" };
    expect(handedBy([handOff, again], "u1")).toBe("u5");
    expect(handedBy([handOff], "u9")).toBeUndefined();
  });
});
