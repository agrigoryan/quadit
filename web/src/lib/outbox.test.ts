// The changes kept on the device (lib/outbox.ts), on an IndexedDB in memory.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { outbox, type OutboxItem } from "@/lib/outbox";

const DAY = 24 * 3600_000;

function item(key: string, over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    key,
    slug: "acme",
    user: "u1",
    tab: "gone-tab",
    changes: [{ id: `ch-${key}`, type: "task.update", args: {} }],
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
    expect(taken[0]?.changes).toEqual([{ id: "ch-k1", type: "task.update", args: {} }]);

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
