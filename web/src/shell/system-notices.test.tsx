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

// What the agents are doing is read from the server; here, nothing yet.
vi.mock("@/data/listening", async (original) => ({
  ...(await original<typeof import("@/data/listening")>()),
  useAgentStates: () => ({ data: undefined, error: "" }),
}));
// The app's answer about its agents is asked of the app through a query of its own: none here.
vi.mock("@/ui/desktop-agents", () => ({ useLocalAgents: () => null }));

const { useSystemNotices } = await import("@/shell/system-notices");
const { useDesktopSummary } = await import("@/shell/desktop-summary");
const { useDesktopRequests } = await import("@/shell/desktop-requests");

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
  desktop = { version: "0.1.0", notify, setBadge, publish: vi.fn(), onRequest: vi.fn() };
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
    decisions: [
      {
        id: "d1",
        task_id: "t1",
        kind: "choice",
        question: "Which jump?",
        state: "open",
        asked_id: "u1",
        options: ["Higher", "Longer", "Floatier", "Heavier"].map((label, i) => ({
          id: `o${i}`,
          decision_id: "d1",
          label,
          rank: `${i}`,
        })),
      },
    ],
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

  it("shows a notification for each new inbox item of mine, in push's words, opening its task", () => {
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
          title: "Bea assigned you SVA-5 Jump feels floaty",
          body: "Can you look at this today?",
          path: "/acme/task/SVA-5",
          tag: "t1",
          id: "n11",
          actions: [{ label: "Mark read", request: "read:n11" }],
        },
      ],
      [
        {
          title: "Bea asked you a question in SVA-5 Jump feels floaty",
          body: "",
          path: "/acme/task/SVA-5#decision-d1",
          tag: "t1",
          id: "n13",
          // As many of the question's options as there is room for, each answering it.
          actions: [
            { label: "Higher", request: "pick:d1:o0" },
            { label: "Longer", request: "pick:d1:o1" },
            { label: "Floatier", request: "pick:d1:o2" },
          ],
        },
      ],
    ]);
  });

  it("opens a page an item is about, and the inbox for one about neither", () => {
    renderHook(() => useSystemNotices());
    streamed(created({ type: "mentioned", doc_id: "p1", title: "Design notes" }), created({ type: "comment" }));
    expect(notify.mock.calls.map(([n]) => n.path)).toEqual(["/acme/docs/p1", "/acme/inbox"]);
  });

  it("offers a reply where something was said to me, in the thread it was said in", () => {
    renderHook(() => useSystemNotices());
    streamed(
      created({ type: "replied", task_id: "t1", entity_type: "comment", entity_id: "c9" }),
      created({ type: "mentioned", doc_id: "p1", entity_type: "doc", entity_id: "p1" }),
      created({ type: "assigned", task_id: "t1" }),
    );
    expect(notify.mock.calls.map(([n]) => [n.reply, n.actions])).toEqual([
      [{ placeholder: "Reply", request: "reply:n11" }, [{ label: "Mark read", request: "read:n11" }]],
      [{ placeholder: "Reply", request: "reply:n12" }, [{ label: "Mark read", request: "read:n12" }]],
      [undefined, [{ label: "Mark read", request: "read:n13" }]],
    ]);
  });

  it("tells nothing when the person turned push off", () => {
    useSession.setState({ user: { id: "u1", name: "Ann", notify: { push: false } } as User });
    renderHook(() => useSystemNotices());
    streamed(created({ task_id: "t1", title: "SVA-5 Jump feels floaty" }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the badge at the workspace's unread count, naming the workspace so the app adds each once", () => {
    const { unmount } = renderHook(() => useSystemNotices());
    expect(setBadge).toHaveBeenLastCalledWith(1, "w");
    streamed(created({ task_id: "t1", title: "SVA-5 Jump feels floaty" }));
    expect(setBadge).toHaveBeenLastCalledWith(2, "w");
    // Signing out takes this window's count off: it shows no workspace.
    unmount();
    expect(setBadge).toHaveBeenLastCalledWith(0);
  });

  it("names each notification by its inbox item, so the app shows it once however many windows hear it", () => {
    renderHook(() => useSystemNotices());
    streamed(created({ task_id: "t1", title: "SVA-5 Jump feels floaty" }));
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ id: "n11" }));
  });
});

describe("in an app released before summaries and requests", () => {
  it("still gets its notifications, and the shell's desktop code asks it for nothing more", () => {
    // Its bridge has no publish and no onRequest; it keeps a notification's own fields and ignores the rest.
    window.quaditDesktop = { version: "0.1.0", notify, setBadge };
    const { unmount } = renderHook(() => {
      useSystemNotices();
      useDesktopSummary();
      useDesktopRequests();
    });
    streamed(created({ task_id: "t1", title: "SVA-5 Jump feels floaty" }));
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ id: "n11", path: "/acme/task/SVA-5" }));
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
