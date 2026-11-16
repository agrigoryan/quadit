// Undo and redo (data/undo.ts): the memory of what was done, and the
// changes it sends to take an edit back and to make it again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap, patchRow } from "@/data/store";
import {
  askToUndo,
  clearUndo,
  nextRedo,
  nextUndo,
  redo,
  remember,
  sendUndoable,
  stopAsking,
  undo,
  useUndo,
} from "@/data/undo";
import { useToasts } from "@/lib/toast";
import type { Member, User, Workspace } from "@/types/core";

type Sent = { id: string; type: string; args: Record<string, unknown>; undoes?: string };

/** Every change the server was sent, in order; `refuse` names a change type it says no to. */
let sent: Sent[] = [];
let refuse = "";

const settle = () => vi.advanceTimersByTimeAsync(0);
const title = () => getState().collections.tasks.t1?.title;
const names = (stack: "done" | "undone") => useUndo.getState()[stack].map((d) => d.name);
const notes = () => useToasts.getState().items.map((item) => item.text);

/** Something done that sends nothing, noting which way it was last crossed. */
function step(name: string, log: string[] = []) {
  return remember(
    name,
    () => Promise.resolve(log.push(`undo ${name}`)),
    () => Promise.resolve(log.push(`redo ${name}`)),
  );
}

function enter(slug: string) {
  loadBootstrap(slug, {
    seq: 10,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: slug, slug } as Workspace,
    tasks: [{ id: "t1", title: "a" }],
  });
}

const retitle = (from: string, to: string) =>
  sendUndoable(
    `retitle to ${to}`,
    {
      changes: [{ type: "task.update", args: { id: "t1", title: to } }],
      show: (tx) => tx.patch("tasks", "t1", { title: to }),
    },
    {
      changes: [{ type: "task.update", args: { id: "t1", title: from } }],
      show: (tx) => tx.patch("tasks", "t1", { title: from }),
    },
  );

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  refuse = "";
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: Sent[] };
    if (changes.some((c) => c.type === refuse || c.args.title === refuse))
      return Promise.reject(new ApiError(400, { message: "no" }));
    sent.push(...changes);
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  clearStore();
  clearUndo();
  useToasts.setState({ items: [] });
  enter("acme");
});

afterEach(async () => {
  await clearOutbox();
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the memory", () => {
  it("undoes the newest first, and does again what was undone last", async () => {
    const log: string[] = [];
    step("one", log);
    step("two", log);
    expect(nextUndo()?.name).toBe("two");
    expect(undo()).toBe(true);
    expect(undo()).toBe(true);
    expect(undo()).toBe(false);
    expect(redo()).toBe(true);
    await settle();
    expect(log).toEqual(["undo two", "undo one", "redo one"]);
    expect(names("done")).toEqual(["one"]);
    expect(names("undone")).toEqual(["two"]);
    expect(notes()).toEqual(["Undone: two", "Undone: one", "Done again: one"]);
  });

  it("forgets what was undone once something new is done", () => {
    step("one");
    undo();
    expect(nextRedo()?.name).toBe("one");
    step("two");
    expect(nextRedo()).toBeUndefined();
    expect(redo()).toBe(false);
  });

  it("keeps the last hundred", () => {
    for (let i = 1; i <= 103; i++) step(String(i));
    expect(names("done")).toHaveLength(100);
    expect(names("done")[0]).toBe("4");
  });

  it("undoes one given entry, wherever it is in the line, once", () => {
    const one = step("one");
    step("two");
    expect(undo(one)).toBe(true);
    expect(undo(one)).toBe(false);
    expect(names("done")).toEqual(["two"]);
  });

  it("does not undo in one workspace what was done in another", () => {
    step("in acme");
    enter("other");
    expect(nextUndo()).toBeUndefined();
    expect(undo()).toBe(false);
    expect(names("done")).toEqual([]);
  });
});

describe("askToUndo", () => {
  it("undoes a recent edit at once", () => {
    step("one");
    expect(askToUndo()).toBe(true);
    expect(useUndo.getState().asking).toBeNull();
    expect(names("undone")).toEqual(["one"]);
    expect(askToUndo()).toBe(false);
  });

  it("asks before undoing what was done more than five minutes ago, and undoes it on a yes", async () => {
    const old = step("one");
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    askToUndo();
    expect(useUndo.getState().asking).toBe(old);
    expect(names("done")).toEqual(["one"]);
    stopAsking();
    expect(names("done")).toEqual(["one"]);
    askToUndo();
    undo(old);
    expect(useUndo.getState().asking).toBeNull();
    expect(names("undone")).toEqual(["one"]);
  });

  it("asks before an undo that loses more than the edit made", () => {
    const made = remember(
      "create",
      () => Promise.resolve(),
      () => Promise.resolve(),
      { warning: "It goes to the trash." },
    );
    askToUndo();
    expect(useUndo.getState().asking).toBe(made);
  });
});

describe("edits that go on from one another", () => {
  const typing = (from: string, to: string) =>
    sendUndoable(
      "retitle",
      {
        changes: [{ type: "task.update", args: { id: "t1", title: to } }],
        show: (tx) => tx.patch("tasks", "t1", { title: to }),
      },
      {
        changes: [{ type: "task.update", args: { id: "t1", title: from } }],
        show: (tx) => tx.patch("tasks", "t1", { title: from }),
      },
      { sameAs: "t1:title" },
    );

  it("are one step, back to before the first and forward to the last", async () => {
    typing("a", "ab");
    await vi.advanceTimersByTimeAsync(500);
    typing("ab", "abc");
    await settle();
    expect(names("done")).toEqual(["retitle"]);
    undo();
    await settle();
    expect(title()).toBe("a");
    redo();
    await settle();
    expect(title()).toBe("abc");
  });

  it("are steps of their own once ten seconds lie between them, or another edit does", async () => {
    typing("a", "ab");
    await vi.advanceTimersByTimeAsync(10_001);
    typing("ab", "abc");
    step("something else");
    typing("abc", "abcd");
    expect(names("done")).toEqual(["retitle", "retitle", "something else", "retitle"]);
  });
});

describe("sendUndoable", () => {
  it("sends the edit at once, the opposite on undo and the edit again on redo", async () => {
    retitle("a", "b");
    expect(title()).toBe("b");
    await settle();
    undo();
    expect(title()).toBe("a");
    await settle();
    redo();
    expect(title()).toBe("b");
    await settle();
    expect(sent.map((c) => c.args.title)).toEqual(["b", "a", "b"]);
  });

  it("the undo names the change it takes back: the edit as it was last sent", async () => {
    retitle("a", "b");
    await settle();
    undo();
    await settle();
    redo();
    await settle();
    undo();
    await settle();
    const [edit, back, again, backAgain] = sent;
    expect(edit?.undoes).toBeUndefined();
    expect(back?.undoes).toBe(edit?.id);
    // Done again it is a new change, and it is that one the second undo takes back.
    expect(again?.id).not.toBe(edit?.id);
    expect(backAgain?.undoes).toBe(again?.id);
  });

  it("undo puts back what the person saw, whatever the field holds by then", async () => {
    retitle("a", "b");
    await settle();
    patchRow("tasks", "t1", { title: "someone else's" });
    undo();
    await settle();
    expect(sent.at(-1)?.args.title).toBe("a");
  });

  it("forgets an edit the server refused", async () => {
    refuse = "b";
    retitle("a", "b");
    await settle();
    expect(title()).toBe("a");
    expect(nextUndo()).toBeUndefined();
  });

  it("forgets an edit whose undo the server refused: there is nothing to do again", async () => {
    retitle("a", "b");
    await settle();
    refuse = "a";
    undo();
    await settle();
    expect(title()).toBe("b");
    expect(nextUndo()).toBeUndefined();
    expect(nextRedo()).toBeUndefined();
  });
});
