// @vitest-environment jsdom
// What the computer is told about the open workspace (shell/system-notices.ts):
// the desktop app gets a notification for each new inbox item that reaches
// this tab off the live stream, and the unread count for its badge; an
// installed web app gets the count through the Badging API; a plain browser
// tab, nothing new.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { useSession } from "@/auth/session";
import { applyEvents, clearStore, loadBootstrap } from "@/data/store";
import type { Member, Notification, User, Workspace } from "@/types/core";
import type { QuaditDesktop } from "@/types/desktop";
import type { FeedEvent } from "@/types/feed";

/** Who hears what this tab reads off the stream: the hook, while it listens. */
const streamListeners = new Set<(events: FeedEvent[]) => void>();
vi.mock("@/data/sync", () => ({
  onStreamEvents(listener: (events: FeedEvent[]) => void) {
    streamListeners.add(listener);
    return () => streamListeners.delete(listener);
  },
}));

const { useSystemNotices } = await import("@/shell/system-notices");

let seq = 10;
const created = (item: Partial<Notification>): FeedEvent => {
  seq++;
  const row = { id: `n${seq}`, user_id: "u1", seq, type: "assigned", actor_id: "u2", created_at: seq, ...item };
  return {
    seq,
    at: seq,
    actor_id: "u2",
    change_id: `c${seq}`,
    type: "notification.created",
    entity_type: "notification",
    entity_id: row.id,
    scope_type: "task",
    scope_id: "t1",
    audience_id: row.user_id,
    data: { row },
  };
};

/** The live stream reaching this tab: into the store, then to whoever listens, as data/sync.ts does. */
function streamed(...events: FeedEvent[]) {
  act(() => {
    applyEvents(events, true);
    for (const listener of streamListeners) listener(events);
  });
}

let notify: Mock<QuaditDesktop["notify"]>;
let setBadge: Mock<QuaditDesktop["setBadge"]>;
let desktop: QuaditDesktop;

beforeEach(() => {
  seq = 10;
  notify = vi.fn();
  setBadge = vi.fn();
  desktop = { version: "0.1.0", notify, setBadge };
  useSession.setState({ status: "in", user: { id: "u1", name: "Ann" } as User });
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    members: [
      { user_id: "u1", name: "Ann", handle: "ann" },
      { user_id: "u2", name: "Bea", handle: "bea" },
    ] as Member[],
    tasks: [{ id: "t1", key: "SVA-5", title: "Jump feels floaty" }],
    notifications: [{ id: "n1", user_id: "u1", seq: 5, type: "comment", actor_id: "u2", created_at: 1 }],
  });
});

afterEach(() => {
  // The shell goes before the copy does, as when the workspace is left.
  cleanup();
  delete window.quaditDesktop;
  clearStore();
  vi.restoreAllMocks();
});

describe("in the desktop app", () => {
  beforeEach(() => {
    window.quaditDesktop = desktop;
  });

  it("shows a notification for each new inbox item of mine, in the inbox's words, opening its task", () => {
    renderHook(() => useSystemNotices());
    streamed(
      created({ task_id: "t1", title: "SVA-5 Jump feels floaty", snippet: "Can you look at this today?" }),
      created({ user_id: "u3", task_id: "t1", title: "SVA-5 Jump feels floaty" }),
      created({
        type: "decision_asked",
        task_id: "t1",
        title: "SVA-5 Jump feels floaty",
        entity_type: "decision",
        entity_id: "d1",
      }),
    );
    expect(notify.mock.calls).toEqual([
      [
        {
          title: "Bea assigned this to you",
          body: "SVA-5 Jump feels floaty\nCan you look at this today?",
          path: "/acme/task/SVA-5",
          tag: "t1",
        },
      ],
      [
        {
          title: "Bea asked you a question",
          body: "SVA-5 Jump feels floaty",
          path: "/acme/task/SVA-5#decision-d1",
          tag: "t1",
        },
      ],
    ]);
  });

  it("opens a page an item is about, and the inbox for one about neither", () => {
    renderHook(() => useSystemNotices());
    streamed(created({ type: "mentioned", doc_id: "p1", title: "Design notes" }), created({ type: "comment" }));
    expect(notify.mock.calls.map(([n]) => n.path)).toEqual(["/acme/docs/p1", "/acme/inbox"]);
  });

  it("tells nothing when the person turned push off", () => {
    useSession.setState({ user: { id: "u1", name: "Ann", notify: { push: false } } as User });
    renderHook(() => useSystemNotices());
    streamed(created({ task_id: "t1", title: "SVA-5 Jump feels floaty" }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the badge at the unread count", () => {
    const { unmount } = renderHook(() => useSystemNotices());
    expect(setBadge).toHaveBeenLastCalledWith(1);
    streamed(created({ task_id: "t1", title: "SVA-5 Jump feels floaty" }));
    expect(setBadge).toHaveBeenLastCalledWith(2);
    // Leaving the workspace, or signing out, takes the count off.
    unmount();
    expect(setBadge).toHaveBeenLastCalledWith(0);
  });
});

describe("in a browser", () => {
  it("listens to nothing and tells no app, without the desktop app", () => {
    renderHook(() => useSystemNotices());
    expect(streamListeners.size).toBe(0);
    streamed(created({ task_id: "t1", title: "SVA-5 Jump feels floaty" }));
    expect(notify).not.toHaveBeenCalled();
    expect(setBadge).not.toHaveBeenCalled();
  });

  it("puts the unread count on the installed app's icon where the browser can", () => {
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    try {
      const { unmount } = renderHook(() => useSystemNotices());
      expect(setAppBadge).toHaveBeenLastCalledWith(1);
      unmount();
      expect(clearAppBadge).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "setAppBadge");
      Reflect.deleteProperty(navigator, "clearAppBadge");
    }
  });
});
