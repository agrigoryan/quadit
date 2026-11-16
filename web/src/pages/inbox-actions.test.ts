// What the inbox's actions send to be undone (pages/inbox-actions.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { clearUndo, nextUndo, undo } from "@/data/undo";
import { useToasts } from "@/lib/toast";
import type { Member, User, Workspace } from "@/types/core";
import { archive, archiveRead, markOpened, markRead } from "@/pages/inbox-actions";

type Sent = { type: string; args: Record<string, unknown> };
let requests: Sent[][] = [];

const settle = () => vi.advanceTimersByTimeAsync(0);
const last = () => (requests.at(-1) ?? []).map(({ type, args }) => ({ type, args }));
const item = (id: string) => getState().collections.notifications[id];

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: Sent[] };
    requests.push(changes);
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  clearStore();
  clearUndo();
  useToasts.setState({ items: [] });
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    notifications: [
      { id: "n1", user_id: "u1", seq: 5 },
      { id: "n2", user_id: "u1", seq: 6, read_at: 100 },
    ],
  });
});

afterEach(async () => {
  await clearOutbox();
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("undoing what was done in the inbox", () => {
  it("puts archived items back in it, unread if they were", async () => {
    archive(["n1", "n2"]);
    expect(item("n1")?.archived_at).toBeTruthy();
    await settle();
    expect(nextUndo()?.name).toBe("archive 2 notifications");
    undo();
    await settle();
    expect(last()).toEqual([
      { type: "notification.read", args: { ids: ["n1", "n2"], unarchive: true } },
      { type: "notification.read", args: { ids: ["n1"], unread: true } },
    ]);
    expect(item("n1")?.archived_at ?? null).toBeNull();
    expect(item("n1")?.read_at ?? null).toBeNull();
    expect(item("n2")?.read_at).toBeTruthy();
  });

  it("makes unread again only the items it marked read", async () => {
    markRead(["n1", "n2"]);
    await settle();
    expect(nextUndo()?.name).toBe("mark 1 notification read");
    undo();
    await settle();
    expect(last()).toEqual([{ type: "notification.read", args: { ids: ["n1"], unread: true } }]);
  });

  it("archives the read items alone, and undone puts them back read", async () => {
    archiveRead(Object.values(getState().collections.notifications));
    expect(item("n2")?.archived_at).toBeTruthy();
    expect(item("n1")?.archived_at ?? null).toBeNull();
    await settle();
    expect(last()).toEqual([{ type: "notification.read", args: { ids: ["n2"], archive: true } }]);
    expect(nextUndo()?.name).toBe("archive 1 notification");
    undo();
    await settle();
    expect(last()).toEqual([{ type: "notification.read", args: { ids: ["n2"], unarchive: true } }]);
    expect(item("n2")?.archived_at ?? null).toBeNull();
    expect(item("n2")?.read_at).toBeTruthy();
  });

  it("sends nothing when no item is read", async () => {
    archiveRead([]);
    await settle();
    expect(requests).toEqual([]);
    expect(nextUndo()).toBeUndefined();
  });

  it("does not remember an item read by being opened", async () => {
    markOpened("n1");
    await settle();
    expect(item("n1")?.read_at).toBeTruthy();
    expect(nextUndo()).toBeUndefined();
  });
});
