// @vitest-environment jsdom
// A change kept on the device (data/outbox.ts) when the page reloads a moment
// after it was made: the browser drops a write to IndexedDB that a page
// leaving has not finished, so the outbox also copies what a tab holds to
// localStorage, at once.

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

const change = { key: "k1", slug: "acme", user: "u1", changes: [], what: "a column's width", at: Date.now() };

/** Lets the page run what it has started, up to the next task. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Outbox = (typeof import("@/data/outbox"))["outbox"];

/** Every page a test loaded: they all stay on the one window the tests share. */
const pages: Outbox[] = [];

/** The outbox as a newly loaded page has it. */
async function newPage() {
  vi.resetModules();
  const { outbox } = await import("@/data/outbox");
  pages.push(outbox);
  return outbox;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  // Forgets at once what each page holds; the write to IndexedDB of a page whose writes never finish is not waited for.
  for (const page of pages.splice(0)) void page.clear();
  await (await newPage()).clear();
});

describe("a page that reloads just after a change", () => {
  it("leaves the change to the next page even when its write to IndexedDB never finished", async () => {
    // This page's writes to IndexedDB never finish, as when the page goes first.
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    const leaving = await newPage();
    leaving.put(change);
    await settle();
    vi.unstubAllGlobals();

    const next = await newPage();
    expect(await next.count("acme", "u1")).toBe(1);
    const taken = await next.adopt("acme", "u1");
    expect(taken.map((item) => item.key)).toEqual(["k1"]);
    // Taken once: it now belongs to this page.
    expect(await next.adopt("acme", "u1")).toEqual([]);
    expect(await next.count("acme", "u1")).toBe(1);
  });

  it("does not leave a change the server has answered for", async () => {
    const leaving = await newPage();
    leaving.put(change);
    leaving.remove("k1");
    expect(await leaving.count("acme", "u1")).toBe(0);

    const next = await newPage();
    expect(await next.adopt("acme", "u1")).toEqual([]);
  });

  it("keeps a change of another workspace for when that workspace opens", async () => {
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    const leaving = await newPage();
    leaving.put({ ...change, slug: "other" });
    await settle();
    vi.unstubAllGlobals();

    const next = await newPage();
    expect(await next.adopt("acme", "u1")).toEqual([]);
    expect((await next.adopt("other", "u1")).map((item) => item.key)).toEqual(["k1"]);
  });

  it("takes a change that reached IndexedDB as well as the copy once", async () => {
    const leaving = await newPage();
    leaving.put(change);
    expect(await leaving.count("acme", "u1")).toBe(1);

    const next = await newPage();
    expect(await next.count("acme", "u1")).toBe(1);
    expect((await next.adopt("acme", "u1")).map((item) => item.key)).toEqual(["k1"]);
  });
});
