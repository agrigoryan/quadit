// Edits through mutate() (lib/mutate.ts): shown at once, sent in order, sent
// again unchanged when the server cannot be reached, undone when refused.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, NetworkError } from "@/lib/api";
import { clearOutbox, mutate } from "@/lib/mutate";
import { applyEvents, clearStore, getState, loadBootstrap } from "@/lib/store";
import type { ChangeResult, FeedEvent, Member, User, Workspace } from "@/lib/types";

/** A change as the server receives it: JSON, read field by field. */
type Sent = { id: string; type: string; args: Record<string, unknown> };

interface Call {
  changes: Sent[];
  answer: (results: ChangeResult[]) => void;
  fail: (err: unknown) => void;
}

/** Stands in for the server: every POST waits until the test answers it. */
function fakeServer(): Call[] {
  const calls: Call[] = [];
  vi.spyOn(api, "post").mockImplementation(
    (_path: string, body?: unknown) =>
      new Promise((resolve, reject) => {
        calls.push({
          changes: (body as { changes: Sent[] }).changes,
          answer: (results) => resolve({ results }),
          fail: reject,
        });
      }),
  );
  return calls;
}

/** Lets the queue run up to its next request. */
const settle = () => vi.advanceTimersByTimeAsync(0);

const retitle = (seq: number, id: string, to: string): FeedEvent => ({
  seq,
  at: seq,
  actor_id: "u2",
  change_id: `c${seq}`,
  type: "task.updated",
  entity_type: "task",
  entity_id: id,
  scope_type: "",
  scope_id: "",
  data: { changes: { title: { from: "", to } } },
});

let calls: Call[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  calls = fakeServer();
  clearStore();
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    tasks: [{ id: "t1", title: "a", priority: 1 }],
  });
});

// Ends whatever a failed test left waiting, so the next test starts with an idle queue.
afterEach(async () => {
  await clearOutbox();
  for (const call of calls) call.fail(new Error("test over"));
  await settle();
  vi.useRealTimers();
});

describe("mutate", () => {
  it("shows the edit at once and, when refused, puts back only the fields still as the edit left them", async () => {
    const done = mutate({ type: "task.update", args: { id: "t1" } }, (tx) => {
      tx.patch("tasks", "t1", { title: "b", priority: 3 });
      tx.insert("tasks", { id: "t2", title: "new" });
    }).catch((err: unknown) => err);
    expect(getState().collections.tasks.t1).toMatchObject({ title: "b", priority: 3 });
    expect(getState().drafts).toEqual({ t2: "tasks" });
    await settle();

    // Someone else retitles the task before the server refuses the edit.
    applyEvents([retitle(11, "t1", "c")], true);
    calls[0]?.fail(new ApiError(400, { message: "no" }));
    expect(await done).toBeInstanceOf(ApiError);

    expect(getState().collections.tasks.t1).toMatchObject({ title: "c", priority: 1 });
    expect(getState().collections.tasks.t2).toBeUndefined();
    expect(getState().drafts).toEqual({});
    expect(getState().unsent).toBe(0);
  });

  it("sends changes one at a time, in the order they were made", async () => {
    const first = mutate({ type: "task.update", args: { id: "t1", title: "x" } });
    const second = mutate({ type: "task.update", args: { id: "t1", title: "y" } });
    await settle();
    expect(calls).toHaveLength(1);
    expect(getState().unsent).toBe(2);

    calls[0]?.answer([]);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.changes[0]?.args.title)).toEqual(["x", "y"]);
    calls[1]?.answer([]);
    await Promise.all([first, second]);
    expect(getState().unsent).toBe(0);
  });

  it("sends a change again with the same change id when the server could not be reached", async () => {
    const done = mutate({ type: "task.update", args: { id: "t1", priority: 2 } }, (tx) =>
      tx.patch("tasks", "t1", { priority: 2 }),
    );
    await settle();
    calls[0]?.fail(new NetworkError());
    await settle();
    expect(getState().offline).toBe(true);
    expect(getState().collections.tasks.t1?.priority).toBe(2);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.changes).toEqual(calls[0]?.changes);
    calls[1]?.answer([]);
    await done;
    expect(getState().offline).toBe(false);
    expect(getState().collections.tasks.t1?.priority).toBe(2);
  });

  it("forgets the whole queue on a 401 without undoing anything", async () => {
    const first = mutate({ type: "task.update", args: { id: "t1" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "b" }),
    ).catch((err: unknown) => err);
    const second = mutate({ type: "task.create", args: { id: "t3" } }, (tx) =>
      tx.insert("tasks", { id: "t3", title: "made" }),
    ).catch((err: unknown) => err);
    await settle();
    calls[0]?.fail(new ApiError(401, { message: "signed out" }));

    expect(await first).toBeInstanceOf(ApiError);
    expect(await second).toBeInstanceOf(ApiError);
    await settle();
    expect(calls).toHaveLength(1);
    expect(getState().collections.tasks.t1?.title).toBe("b");
    expect(getState().collections.tasks.t3?.title).toBe("made");
    expect(getState().drafts).toEqual({});
    expect(getState().unsent).toBe(0);
  });
});
