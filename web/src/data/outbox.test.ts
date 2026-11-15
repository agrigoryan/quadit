// The changes kept on the device (data/outbox.ts), on an IndexedDB in memory.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outbox, type OutboxChange, type OutboxItem } from "@/data/outbox";

const DAY = 24 * 3600_000;

function item(key: string, over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    key,
    slug: "acme",
    user: "u1",
    tab: "gone-tab",
    changes: [{ id: `ch-${key}`, type: "task.update", args: { id: "t1" } }],
    what: key,
    at: Date.now(),
    ...over,
  };
}

/** Writes items as other tabs would have left them. */
function leave(items: OutboxItem[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("quadit-outbox", 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("changes", "readwrite");
      for (const it of items) tx.objectStore("changes").put(it);
      tx.oncomplete = () => {
        req.result.close();
        resolve();
      };
    };
  });
}

/** Holds a tab's lock as an open page does, until the returned function is called. */
function openTab(tab: string): Promise<() => void> {
  return new Promise((granted) => {
    void navigator.locks.request(`quadit-tab-${tab}`, () => new Promise<void>((close) => granted(close)));
  });
}

beforeEach(async () => {
  // The first call creates the database; then start each test empty.
  await outbox.clear();
});

afterEach(() => vi.unstubAllGlobals());

describe("outbox.adopt", () => {
  it("takes the items of tabs that are gone, for this workspace and person only, oldest first", async () => {
    const closeTab = await openTab("open-tab");
    await leave([
      item("k3"),
      item("k1"),
      item("k2", { tab: "open-tab" }),
      item("k4", { slug: "other" }),
      item("k5", { user: "u2" }),
    ]);

    const taken = await outbox.adopt("acme", "u1");
    expect(taken.map((i) => i.key)).toEqual(["k1", "k3"]);
    expect(taken[0]?.changes).toEqual([{ id: "ch-k1", type: "task.update", args: { id: "t1" } }]);

    // Taken once: they now belong to this tab, and nothing else changed hands.
    expect(await outbox.adopt("acme", "u1")).toEqual([]);
    expect(await outbox.count("acme", "u1")).toBe(3);
    closeTab();
  });

  it("does not take back what this tab put", async () => {
    outbox.put({ key: "k1", slug: "acme", user: "u1", changes: [], what: "", at: Date.now() });
    expect(await outbox.adopt("acme", "u1")).toEqual([]);
    expect(await outbox.count("acme", "u1")).toBe(1);
  });

  it("drops items nobody came back for in thirty days, whoever they belong to", async () => {
    await leave([
      item("k1", { at: Date.now() - 31 * DAY }),
      item("k2", { at: Date.now() - 31 * DAY, slug: "other" }),
      item("k3", { at: Date.now() - 29 * DAY }),
    ]);
    const taken = await outbox.adopt("acme", "u1");
    expect(taken.map((i) => i.key)).toEqual(["k3"]);
    expect(await outbox.count("acme", "u1")).toBe(1);
    expect(await outbox.count("other", "u1")).toBe(0);
  });
});

describe("outbox.count", () => {
  it("counts what is kept for one workspace and person, whichever tab holds it, a batch once", async () => {
    const closeTab = await openTab("open-tab");
    const batch: OutboxChange[] = [
      { id: "c1", type: "task.update", args: { id: "t1" } },
      { id: "c2", type: "task.update", args: { id: "t1" } },
    ];
    await leave([
      item("k1"),
      item("k2", { tab: "open-tab", changes: batch }),
      item("k3", { slug: "other" }),
      item("k4", { user: "u2" }),
    ]);
    outbox.put({ key: "k5", slug: "acme", user: "u1", changes: batch.slice(0, 1), what: "", at: Date.now() });

    expect(await outbox.count("acme", "u1")).toBe(3);
    expect(await outbox.count("other", "u1")).toBe(1);
    expect(await outbox.count("acme", "u2")).toBe(1);
    expect(await outbox.count("acme", "nobody")).toBe(0);
    closeTab();
  });
});

describe("outbox.clear", () => {
  it("forgets everything kept on the device, for every workspace and person, and who queued last", async () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    });
    await leave([item("k1"), item("k2", { slug: "other", user: "u2" })]);
    outbox.put({ key: "k3", slug: "acme", user: "u1", changes: [], what: "", at: Date.now() });
    expect(outbox.lastUser()).toBe("u1");

    await outbox.clear();
    expect(await outbox.count("acme", "u1")).toBe(0);
    expect(await outbox.count("other", "u2")).toBe(0);
    expect(await outbox.adopt("acme", "u1")).toEqual([]);
    expect(outbox.lastUser()).toBeUndefined();
  });
});

describe("where the browser has no locks", () => {
  it("takes over what any other tab left, open or not, since it cannot tell which are open", async () => {
    const closeTab = await openTab("open-tab");
    await leave([item("k2", { tab: "open-tab" }), item("k1"), item("k3", { user: "u2" })]);
    // The outbox looks for locks once, as it loads: load it anew in a browser without them.
    vi.stubGlobal("navigator", {});
    vi.resetModules();
    const { outbox: withoutLocks } = await import("@/data/outbox");

    const taken = await withoutLocks.adopt("acme", "u1");
    expect(taken.map((i) => i.key)).toEqual(["k1", "k2"]);
    // They are this tab's now.
    expect(await withoutLocks.adopt("acme", "u1")).toEqual([]);
    expect(await withoutLocks.count("acme", "u1")).toBe(2);
    closeTab();
  });
});
