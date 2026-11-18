import { describe, expect, it } from "vitest";
import { NoticeGate } from "@/main/notices";

const note = (extra: Record<string, unknown> = {}) => ({
  title: "Bea assigned you",
  body: "SVA-5",
  path: "/e2e",
  ...extra,
});

describe("NoticeGate", () => {
  it("lets a well-formed notification through, as plain strings of bounded size", () => {
    const gate = new NoticeGate();
    expect(gate.admit("s1", note({ tag: "t1", id: "n1" }), 0)).toEqual({
      title: "Bea assigned you",
      body: "SVA-5",
      path: "/e2e",
      tag: "t1",
      id: "n1",
    });
    const long = gate.admit("s1", note({ title: "x".repeat(5000), body: "y".repeat(50_000) }), 0);
    expect(long?.title).toHaveLength(200);
    expect(long?.body).toHaveLength(1000);
  });

  it("refuses what is not one", () => {
    const gate = new NoticeGate();
    for (const raw of [
      null,
      "text",
      [],
      note({ title: 5 }),
      note({ body: { toString: () => "x" } }),
      note({ path: undefined }),
      note({ path: "/" + "p".repeat(3000) }),
      note({ tag: 7 }),
      note({ id: "i".repeat(500) }),
    ]) {
      expect(gate.admit("s1", raw, 0), JSON.stringify(raw)).toBeNull();
    }
  });

  it("shows an inbox item once, whichever window tells it, on each server", () => {
    const gate = new NoticeGate();
    expect(gate.admit("s1", note({ id: "n1" }), 0)).not.toBeNull();
    expect(gate.admit("s1", note({ id: "n1" }), 1)).toBeNull();
    expect(gate.admit("s2", note({ id: "n1" }), 2)).not.toBeNull();
    // Without an id there is nothing to know it by.
    expect(gate.admit("s1", note(), 3)).not.toBeNull();
    expect(gate.admit("s1", note(), 4)).not.toBeNull();
  });

  it("lets a server show only so many at a time, then more as time passes", () => {
    const gate = new NoticeGate();
    const shown = Array.from({ length: 30 }, (_, i) => gate.admit("s1", note({ id: `n${i}` }), 1000 + i)).filter(
      Boolean,
    );
    expect(shown).toHaveLength(10);
    // Another server has its own allowance.
    expect(gate.admit("s2", note({ id: "x" }), 1100)).not.toBeNull();
    // A minute on, the server may show again.
    expect(gate.admit("s1", note({ id: "later" }), 1000 + 61_000)).not.toBeNull();
  });
});
