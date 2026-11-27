// Where the cards in a page's margin go (docs/comments/stack.ts): each
// level with its words when there is room, none over another, the active
// one where its words are with the others moved out of its way.

import { describe, expect, it } from "vitest";
import { stackCards } from "@/docs/comments/stack";

const tops = (placed: Map<string, number>) => Object.fromEntries(placed);

describe("stackCards", () => {
  it("puts each card level with its words when they are far enough apart", () => {
    const placed = stackCards(
      [
        { id: "a", want: 0, height: 50 },
        { id: "b", want: 100, height: 50 },
      ],
      null,
      8,
    );
    expect(tops(placed)).toEqual({ a: 0, b: 100 });
  });

  it("pushes a later card down below the one it would overlap, and the next ones after it", () => {
    const placed = stackCards(
      [
        { id: "a", want: 0, height: 80 },
        { id: "b", want: 20, height: 40 },
        { id: "c", want: 100, height: 40 },
        { id: "d", want: 400, height: 40 },
      ],
      null,
      8,
    );
    expect(tops(placed)).toEqual({ a: 0, b: 88, c: 136, d: 400 });
  });

  it("takes cards by where their words are, and in the order given when two are on the same line", () => {
    const placed = stackCards(
      [
        { id: "late", want: 200, height: 40 },
        { id: "first", want: 10, height: 40 },
        { id: "second", want: 10, height: 40 },
      ],
      null,
      8,
    );
    expect(tops(placed)).toEqual({ first: 10, second: 58, late: 200 });
  });

  it("keeps the active card level with its words and moves the cards above it up, those below down", () => {
    const placed = stackCards(
      [
        { id: "a", want: 100, height: 40 },
        { id: "b", want: 130, height: 40 },
        { id: "c", want: 150, height: 120 },
        { id: "d", want: 160, height: 40 },
      ],
      "c",
      8,
    );
    expect(tops(placed)).toEqual({ a: 54, b: 102, c: 150, d: 278 });
  });

  it("moves the active card down as little as it must when the cards above it would go past the top", () => {
    const placed = stackCards(
      [
        { id: "a", want: 0, height: 40 },
        { id: "b", want: 30, height: 40 },
        { id: "c", want: 50, height: 120 },
        { id: "d", want: 60, height: 40 },
      ],
      "c",
      8,
    );
    expect(tops(placed)).toEqual({ a: 0, b: 48, c: 96, d: 224 });
  });

  it("leaves cards above the active one where they are when they do not reach it", () => {
    const placed = stackCards(
      [
        { id: "a", want: 0, height: 40 },
        { id: "b", want: 300, height: 40 },
      ],
      "b",
      8,
    );
    expect(tops(placed)).toEqual({ a: 0, b: 300 });
  });

  it("never lets two cards overlap, whichever is active", () => {
    const cards = [
      { id: "a", want: 5, height: 70 },
      { id: "b", want: 10, height: 30 },
      { id: "c", want: 12, height: 50 },
      { id: "d", want: 90, height: 20 },
      { id: "e", want: 95, height: 60 },
    ];
    for (const active of [null, "a", "b", "c", "d", "e"]) {
      const placed = stackCards(cards, active, 8);
      const spans = cards
        .map((c) => ({ top: placed.get(c.id) ?? NaN, bottom: (placed.get(c.id) ?? NaN) + c.height }))
        .sort((x, y) => x.top - y.top);
      for (let i = 1; i < spans.length; i++)
        expect(spans[i]?.top).toBeGreaterThanOrEqual((spans[i - 1]?.bottom ?? 0) + 8);
    }
  });

  it("places nothing when there are no cards, and ignores an active card that is not among them", () => {
    expect(stackCards([], "x", 8).size).toBe(0);
    expect(tops(stackCards([{ id: "a", want: 3, height: 10 }], "x", 8))).toEqual({ a: 3 });
  });
});
