// @vitest-environment jsdom
// Looking at a task or a page reads my inbox items about it (data/inbox-read.ts):
// after it has been loaded and shown a moment, not when it is flipped past or
// waits in a background tab; the task's items up to the newest there was when
// the moment began; quietly, with nothing to undo and nothing said if refused.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { SEEN_AFTER_MS, useReadWhenSeen } from "@/data/inbox-read";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { clearUndo, nextUndo } from "@/data/undo";
import { useToasts } from "@/lib/toast";
import type { Member, Notification, User, Workspace } from "@/types/core";

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

const item = (id: string, over: Partial<Notification>): Notification => ({
  id,
  user_id: "u1",
  seq: 1,
  type: "comment",
  actor_id: "u2",
  created_at: 1,
  ...over,
});

function load(me: Member = { user_id: "u1", role: "member" } as Member) {
  clearStore();
  loadBootstrap("acme", {
    seq: 10,
    me,
    user: { id: me.user_id } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    notifications: [
      item("n1", { task_id: "t1", seq: 5, addressed: true }),
      item("n2", { task_id: "t1", seq: 7 }),
      item("n3", { task_id: "t1", seq: 3, read_at: 2 }),
      item("n4", { task_id: "t2", seq: 8 }),
      item("n5", { doc_id: "d1", seq: 9 }),
      item("n6", { task_id: "t1", seq: 6, user_id: "u9" }),
    ],
  });
}

const readAt = (id: string) => getState().collections.notifications[id]?.read_at;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: Sent[] };
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  clearUndo();
  useToasts.setState({ items: [] });
  load();
});

afterEach(async () => {
  vi.useRealTimers();
  await clearOutbox();
  vi.restoreAllMocks();
});

/** The page shown, or put in the background. */
function visible(shown: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (shown ? "visible" : "hidden") });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useReadWhenSeen", () => {
  afterEach(() => visible(true));

  it("reads a task's unread items once it has been open a moment, up to the newest there was, quietly", async () => {
    renderHook(() => useReadWhenSeen({ taskId: "t1", ready: true }));
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ type: "notification.read", args: { task: "t1", up_to: 7 } }]);
    // Nothing to undo, nothing said, nothing shown ahead of the server: the feed brings the items read.
    expect(nextUndo()).toBeUndefined();
    expect(useToasts.getState().items).toEqual([]);
    expect(readAt("n1")).toBeUndefined();
  });

  it("reads nothing of a task flipped past before the moment is up", async () => {
    const { rerender } = renderHook(({ taskId }) => useReadWhenSeen({ taskId, ready: true }), {
      initialProps: { taskId: "t1" },
    });
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS / 2);
    rerender({ taskId: "t2" });
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    expect(sent).toEqual([{ type: "notification.read", args: { task: "t2", up_to: 8 } }]);
  });

  it("counts the moment only while the page is shown: a task opened in a background tab reads nothing until looked at", async () => {
    visible(false);
    renderHook(() => useReadWhenSeen({ taskId: "t1", ready: true }));
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS * 5);
    expect(sent).toEqual([]);
    visible(true);
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS / 2);
    // Put away again before the moment is up: it starts over when shown.
    visible(false);
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    expect(sent).toEqual([]);
    visible(true);
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    expect(sent).toEqual([{ type: "notification.read", args: { task: "t1", up_to: 7 } }]);
  });

  it("counts the moment only once the task has loaded", async () => {
    const { rerender } = renderHook(({ ready }) => useReadWhenSeen({ taskId: "t1", ready }), {
      initialProps: { ready: false },
    });
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS * 3);
    expect(sent).toEqual([]);
    rerender({ ready: true });
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    expect(sent).toEqual([{ type: "notification.read", args: { task: "t1", up_to: 7 } }]);
  });

  it("names what was unread when the moment began, not what came during it", async () => {
    renderHook(() => useReadWhenSeen({ taskId: "t1", ready: true }));
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS / 2);
    loadBootstrap("acme", {
      seq: 11,
      me: { user_id: "u1", role: "member" } as Member,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme" } as Workspace,
      notifications: [...Object.values(getState().collections.notifications), item("n7", { task_id: "t1", seq: 12 })],
    });
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    expect(sent).toEqual([{ type: "notification.read", args: { task: "t1", up_to: 7 } }]);
  });

  it("says nothing when the server refuses it", async () => {
    vi.mocked(api.post).mockRejectedValue(Object.assign(new Error("this task is in the trash"), { status: 422 }));
    renderHook(() => useReadWhenSeen({ taskId: "t1", ready: true }));
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(useToasts.getState().items).toEqual([]);
    expect(readAt("n1")).toBeUndefined();
  });

  it("reads a page's items by their ids", async () => {
    renderHook(() => useReadWhenSeen({ docId: "d1", ready: true }));
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    expect(sent).toEqual([{ type: "notification.read", args: { ids: ["n5"] } }]);
  });

  it("sends nothing when nothing about it is unread, or for a member who may change nothing", async () => {
    renderHook(() => useReadWhenSeen({ taskId: "t9", ready: true }));
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    load({ user_id: "u1", role: "member", scope: { read_only: true } } as Member);
    renderHook(() => useReadWhenSeen({ taskId: "t1", ready: true }));
    await vi.advanceTimersByTimeAsync(SEEN_AFTER_MS);
    expect(sent).toEqual([]);
    expect(readAt("n1")).toBeUndefined();
  });
});
