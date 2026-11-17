// Edits through mutate() (data/mutate.ts): shown at once, sent in order, sent
// again unchanged when the server cannot be reached, undone when refused.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, NetworkError, noteReachable } from "@/data/api";
import { clearOutbox, mutate, restoreQueue } from "@/data/mutate";
import { outbox, type OutboxItem } from "@/data/outbox";
import { applyEvents, clearStore, getState, loadBootstrap, mergeRows } from "@/data/store";
import { toast } from "@/lib/toast";
import type { ChangeResult, FeedEvent, Member, User, Workspace } from "@/types/core";

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

  it("keeps showing a later edit of a field while the answer to an earlier one comes in", async () => {
    const title = () => getState().collections.tasks.t1?.title;
    const first = mutate({ type: "task.update", args: { id: "t1", title: "x" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "x" }),
    );
    const second = mutate({ type: "task.update", args: { id: "t1", title: "y" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "y" }),
    );
    await settle();
    expect(title()).toBe("y");

    // The server answers the first with its event: the title became "x". The second is still on its way.
    calls[0]?.answer([
      { change_id: "c11", type: "task.update", seq: 11, first_seq: 11, events: [retitle(11, "t1", "x")] },
    ]);
    await settle();
    expect(title()).toBe("y");
    // So does anyone else's change that arrives meanwhile: this person's edit is the later one.
    applyEvents([retitle(12, "t1", "z")], true);
    expect(title()).toBe("y");

    calls[1]?.answer([
      { change_id: "c13", type: "task.update", seq: 13, first_seq: 13, events: [retitle(13, "t1", "y")] },
    ]);
    await Promise.all([first, second]);
    expect(title()).toBe("y");
  });

  it("when a later edit is refused, shows what the server has, not the edit before it that the server already replaced", async () => {
    const title = () => getState().collections.tasks.t1?.title;
    const first = mutate({ type: "task.update", args: { id: "t1", title: "x" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "x" }),
    );
    const second = mutate({ type: "task.update", args: { id: "t1", title: "y" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "y" }),
    ).catch(() => {});
    await settle();
    calls[0]?.answer([
      { change_id: "c11", type: "task.update", seq: 11, first_seq: 11, events: [retitle(11, "t1", "x")] },
    ]);
    await settle();
    calls[1]?.fail(new ApiError(409, { message: "no" }));
    await Promise.all([first, second]);
    expect(title()).toBe("x");
  });

  it("when both of two waiting edits of a field are refused, puts back what the field held before either", async () => {
    const title = () => getState().collections.tasks.t1?.title;
    const first = mutate({ type: "task.update", args: { id: "t1", title: "x" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "x" }),
    ).catch(() => {});
    const second = mutate({ type: "task.update", args: { id: "t1", title: "y" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "y" }),
    ).catch(() => {});
    await settle();
    calls[0]?.fail(new ApiError(400, { message: "no" }));
    await settle();
    // The later edit is still waiting, and still shows.
    expect(title()).toBe("y");
    calls[1]?.fail(new ApiError(400, { message: "no" }));
    await Promise.all([first, second]);
    expect(title()).toBe("a");
  });

  it("a waiting edit that is refused goes back to what someone else set meanwhile", async () => {
    const title = () => getState().collections.tasks.t1?.title;
    const edit = mutate({ type: "task.update", args: { id: "t1", title: "x" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "x" }),
    ).catch(() => {});
    await settle();
    applyEvents([retitle(11, "t1", "theirs")], true);
    expect(title()).toBe("x");
    calls[0]?.fail(new ApiError(400, { message: "no" }));
    await edit;
    expect(title()).toBe("theirs");
  });

  it("keeps showing a waiting edit when an event brings the whole row, whatever fields its changes name", async () => {
    const title = () => getState().collections.tasks.t1?.title;
    const edit = mutate({ type: "task.update", args: { id: "t1", title: "x" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "x" }),
    ).catch(() => {});
    await settle();
    // Someone brings the task back from the trash: the event names deleted_at, and its row writes every field.
    applyEvents(
      [
        {
          ...retitle(11, "t1", ""),
          data: {
            changes: { deleted_at: { from: 5, to: 0 } },
            restored: true,
            row: { id: "t1", title: "a", priority: 1 },
          },
        },
      ],
      true,
    );
    expect(title()).toBe("x");
    calls[0]?.answer([
      { change_id: "c12", type: "task.update", seq: 12, first_seq: 12, events: [retitle(12, "t1", "x")] },
    ]);
    await edit;
    expect(title()).toBe("x");
  });

  it("keeps showing a waiting edit over the row a fetch brings, read before the edit reached the server", async () => {
    const title = () => getState().collections.tasks.t1?.title;
    const edit = mutate({ type: "task.update", args: { id: "t1", title: "x" } }, (tx) =>
      tx.patch("tasks", "t1", { title: "x" }),
    ).catch(() => {});
    await settle();
    // The task's details arrive, as the server had them before the edit.
    mergeRows("tasks", [{ id: "t1", title: "a", priority: 1, description: "whole", updated_seq: 9 } as never]);
    expect(getState().collections.tasks.t1).toMatchObject({ title: "x", description: "whole" });
    // Refused, the field goes back to what the fetch said the server has.
    calls[0]?.fail(new ApiError(400, { message: "no" }));
    await edit;
    expect(title()).toBe("a");
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

  it("waits about a second before the first new try, and tries at once when the server is heard from", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const done = mutate({ type: "task.update", args: { id: "t1", priority: 2 } });
    await settle();
    calls[0]?.fail(new NetworkError());
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    calls[1]?.fail(new NetworkError());
    await settle();
    noteReachable();
    await settle();
    expect(calls).toHaveLength(3);
    calls[2]?.answer([]);
    await done;
  });

  it("does not make a change wait behind a retry of one that was forgotten meanwhile", async () => {
    const forgotten = mutate({ type: "task.update", args: { id: "t1", title: "x" } }).catch((err: unknown) => err);
    await settle();
    calls[0]?.fail(new NetworkError());
    await settle();
    await clearOutbox();
    expect(await forgotten).toBeInstanceOf(Error);

    const next = mutate({ type: "task.update", args: { id: "t1", title: "y" } });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.changes[0]?.args.title).toBe("y");
    calls[1]?.answer([]);
    await next;
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

  it("keeps a row made here as a draft until the server answers for it", async () => {
    const done = mutate({ type: "task.create", args: { id: "t2" } }, (tx) =>
      tx.insert("tasks", { id: "t2", title: "new" }),
    );
    await settle();
    expect(getState().drafts).toEqual({ t2: "tasks" });
    calls[0]?.answer([]);
    await done;
    expect(getState().drafts).toEqual({});
    expect(getState().collections.tasks.t2?.title).toBe("new");
  });

  it("when refused, takes an inserted row out again and puts a removed row back", async () => {
    const done = mutate({ type: "task.delete", args: { id: "t1" } }, (tx) => {
      tx.insert("tasks", { id: "t2", title: "new" });
      tx.remove("tasks", "t1");
    }).catch((err: unknown) => err);
    expect(getState().collections.tasks.t1).toBeUndefined();
    await settle();
    calls[0]?.fail(new ApiError(400, { message: "no" }));
    await done;
    expect(getState().collections.tasks.t1).toMatchObject({ title: "a", priority: 1 });
    expect(getState().collections.tasks.t2).toBeUndefined();
  });

  it("does not put a removed row back over one that has come back by itself meanwhile", async () => {
    const done = mutate({ type: "task.delete", args: { id: "t1" } }, (tx) => tx.remove("tasks", "t1")).catch(
      (err: unknown) => err,
    );
    await settle();
    applyEvents([{ ...retitle(11, "t1", ""), data: { row: { id: "t1", title: "theirs" } } }], true);
    calls[0]?.fail(new ApiError(400, { message: "no" }));
    await done;
    expect(getState().collections.tasks.t1).toEqual({ id: "t1", title: "theirs" });
  });
});

describe("restoreQueue", () => {
  /** A change an earlier page of this workspace made and could not send. */
  const leftBehind = (key: string, title: string): OutboxItem => ({
    key,
    slug: "acme",
    user: "u1",
    tab: "a-page-that-is-gone",
    changes: [{ id: `change-${key}`, type: "task.update", args: { id: "t1", title } }],
    what: `the change ${key}`,
    at: 0,
  });
  const sentTitles = () => calls.map((call) => call.changes[0]?.args.title);

  it("sends what an earlier page left behind before the changes waiting here, but never ahead of the request on its way", async () => {
    vi.spyOn(outbox, "adopt").mockResolvedValue([leftBehind("k1", "left first"), leftBehind("k2", "left second")]);
    const here = [
      mutate({ type: "task.update", args: { id: "t1", title: "on its way" } }),
      mutate({ type: "task.update", args: { id: "t1", title: "waiting here" } }),
    ];
    await settle();
    expect(calls).toHaveLength(1);

    await restoreQueue("acme");
    expect(getState().unsent).toBe(4);
    for (let i = 0; i < 4; i++) {
      calls[i]?.answer([]);
      await settle();
    }
    await Promise.all(here);
    expect(sentTitles()).toEqual(["on its way", "left first", "left second", "waiting here"]);
    expect(calls[1]?.changes[0]?.id).toBe("change-k1");
    expect(getState().unsent).toBe(0);
  });

  it("sends them at once when nothing is on its way, ahead of what is made after", async () => {
    vi.spyOn(outbox, "adopt").mockResolvedValue([leftBehind("k1", "left behind")]);
    await restoreQueue("acme");
    await settle();
    expect(sentTitles()).toEqual(["left behind"]);
    const here = mutate({ type: "task.update", args: { id: "t1", title: "made after" } });
    calls[0]?.answer([]);
    await settle();
    calls[1]?.answer([]);
    await here;
    expect(sentTitles()).toEqual(["left behind", "made after"]);
  });

  it("takes nothing over for a workspace other than the one on screen", async () => {
    const adopt = vi.spyOn(outbox, "adopt").mockResolvedValue([leftBehind("k1", "left behind")]);
    await restoreQueue("other");
    await settle();
    expect(adopt).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("says what was not saved when the server refuses a change taken over: nothing on screen can be undone", async () => {
    vi.spyOn(outbox, "adopt").mockResolvedValue([leftBehind("k1", "left behind")]);
    const said = vi.spyOn(toast, "error").mockImplementation(() => {});
    await restoreQueue("acme");
    await settle();
    calls[0]?.fail(new ApiError(400, { message: "no such task" }));
    await settle();
    expect(said).toHaveBeenCalledWith("Not saved: the change k1. no such task");
    expect(getState().unsent).toBe(0);
    expect(getState().collections.tasks.t1?.title).toBe("a");
  });
});
