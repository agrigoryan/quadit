// What a page's edits send to be undone (docs/actions.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { askToUndo, clearUndo, nextUndo, redo, undo, useUndo } from "@/data/undo";
import { useToasts } from "@/lib/toast";
import type { Member, User, Workspace } from "@/types/core";
import { createDoc, moveDoc, setRowProps, setSharing, trashDoc, updateDoc } from "@/docs/actions";

type Sent = { type: string; args: Record<string, unknown> };
let requests: Sent[][] = [];

const settle = () => vi.advanceTimersByTimeAsync(0);
const last = () => (requests.at(-1) ?? []).map(({ type, args }) => ({ type, args }));
const doc = (id: string) => getState().collections.docs[id];

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
    docs: [
      { id: "d1", kind: "page", title: "Handbook", rank: "b", icon: "📘" },
      { id: "d2", kind: "page", title: "Onboarding", rank: "d", parent_id: "d1" },
      { id: "d3", kind: "page", title: "Hers", rank: "f", owner_id: "u2", shared_with: ["u1"] },
      { id: "r1", kind: "row", title: "Row", rank: "h", props: { size: "L" } },
    ],
  });
});

afterEach(async () => {
  await clearOutbox();
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("undoing a change to a page", () => {
  it("gives it back its title and its icon", async () => {
    updateDoc("d1", { title: "Guide", icon: "" });
    await settle();
    expect(nextUndo()?.name).toBe("change the page “Handbook”");
    undo();
    await settle();
    expect(last()).toEqual([{ type: "doc.update", args: { id: "d1", title: "Handbook", icon: "📘" } }]);
    expect(doc("d1")).toMatchObject({ title: "Handbook", icon: "📘" });
  });

  it("moves it back under the page it was under, at its place", async () => {
    moveDoc("d2", null, "z");
    await settle();
    undo();
    await settle();
    expect(last()).toEqual([{ type: "doc.update", args: { id: "d2", rank: "d", parent: "d1" } }]);
    expect(doc("d2")).toMatchObject({ parent_id: "d1", rank: "d" });
  });

  it("brings a trashed page back with the pages under it", async () => {
    trashDoc("d1");
    await settle();
    expect(doc("d2")?.deleted_at).toBeTruthy();
    undo();
    await settle();
    expect(last()).toEqual([{ type: "doc.restore", args: { id: "d1" } }]);
    expect(doc("d2")?.deleted_at ?? null).toBeNull();
    redo();
    await settle();
    expect(last()).toEqual([{ type: "doc.delete", args: { id: "d1" } }]);
  });

  it("asks before undoing a page just made, which goes to the trash", async () => {
    const id = createDoc({ title: "Notes" });
    await settle();
    askToUndo();
    const asking = useUndo.getState().asking;
    expect(asking?.warning).toBeTruthy();
    undo(asking ?? undefined);
    await settle();
    expect(last()).toEqual([{ type: "doc.delete", args: { id } }]);
  });

  it("makes a page shared again as it was, but remembers nothing of a change to someone else's page", async () => {
    setSharing("d1", { private: true });
    await settle();
    undo();
    await settle();
    expect(last()).toEqual([{ type: "doc.update", args: { id: "d1", private: false } }]);

    clearUndo();
    setSharing("d3", { sharedWith: [] });
    await settle();
    expect(nextUndo()).toBeUndefined();
  });

  it("gives a row back the values it had", async () => {
    setRowProps("r1", { size: "XL", color: "red" });
    await settle();
    undo();
    await settle();
    expect(last()).toEqual([{ type: "doc.update", args: { id: "r1", props: { size: "L", color: null } } }]);
    expect(doc("r1")?.props).toEqual({ size: "L" });
  });
});
