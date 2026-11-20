import { describe, expect, it } from "vitest";
import { PendingLoads } from "@/main/pending-loads";

/** A gate per key that the test opens, and what arrived through it. */
function setUp() {
  const gates = new Map<string, (opened: boolean) => void>();
  const arrived: { key: string; load: string; opened: boolean }[] = [];
  let asked = 0;
  const loads = new PendingLoads<string, string, boolean>(
    (key) => {
      asked++;
      return new Promise((open) => gates.set(key, open));
    },
    (key, load, opened) => arrived.push({ key, load, opened }),
  );
  const open = async (key: string, opened = true) => {
    gates.get(key)?.(opened);
    await new Promise((done) => setImmediate(done));
  };
  return { loads, arrived, open, asked: () => asked };
}

describe("PendingLoads", () => {
  it("loads what was asked once the gate opens, with what the gate said", async () => {
    const { loads, arrived, open } = setUp();
    loads.ask("a", "/");
    expect(arrived).toEqual([]);
    await open("a", false);
    expect(arrived).toEqual([{ key: "a", load: "/", opened: false }]);
  });

  it("keeps only the newest load asked while it waits, under the one wait", async () => {
    const { loads, arrived, open, asked } = setUp();
    loads.ask("a", "/");
    loads.ask("a", "/games/SVA-12");
    expect(asked()).toBe(1);
    await open("a");
    expect(arrived).toEqual([{ key: "a", load: "/games/SVA-12", opened: true }]);
  });

  it("waits again for a load asked after the last one arrived, and keeps keys apart", async () => {
    const { loads, arrived, open, asked } = setUp();
    loads.ask("a", "/");
    loads.ask("b", "/b");
    await open("a");
    loads.ask("a", "/again");
    expect(asked()).toBe(3);
    await open("a");
    await open("b");
    expect(arrived.map((a) => `${a.key}${a.load}`)).toEqual(["a/", "a/again", "b/b"]);
  });

  it("drops the load of a key that is forgotten while it waits", async () => {
    const { loads, arrived, open } = setUp();
    loads.ask("a", "/");
    loads.forget("a");
    await open("a");
    expect(arrived).toEqual([]);
  });
});
