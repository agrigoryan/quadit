import { describe, expect, it } from "vitest";
import { Draws } from "@/pages/draws";

/** A promise settled from outside, to force the order answers come in. */
function later<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (settle = done));
  return { promise, settle };
}

/**
 * A draw as Connect agents makes one: the tools as seen from the workspace
 * the window shows when it asks (`answer`), then where each stands
 * (`handshake`); what it would draw goes into `drawn`, if it still counts.
 */
async function draw(
  draws: Draws,
  drawn: string[],
  answer: Promise<string>,
  handshake: Promise<string> = Promise.resolve("its cards"),
) {
  const d = draws.begin();
  const workspace = await answer;
  d.isFor(workspace);
  if (!d.counts()) return;
  const stands = await handshake;
  if (d.counts()) drawn.push(`${workspace}: ${stands}`);
}

describe("Draws", () => {
  it("drops a draw for A whose handshake answers after the window turned to B and B was drawn", async () => {
    const draws = new Draws();
    draws.show("A");
    const drawn: string[] = [];
    const handshakes = { A: later<string>(), B: later<string>() };
    const a = draw(draws, drawn, Promise.resolve("A"), handshakes.A.promise);
    await Promise.resolve();
    await Promise.resolve();
    // The window turns to B before A's handshake answered: B is to be drawn.
    expect(draws.show("B")).toBe(true);
    const b = draw(draws, drawn, Promise.resolve("B"), handshakes.B.promise);
    handshakes.B.settle("B's card");
    await b;
    handshakes.A.settle("A's code");
    await a;
    expect(drawn).toEqual(["B: B's card"]);
    expect(draws.show("B")).toBe(false);
  });

  it("drops A's tools that answer after the window turned to B while they were asked, and asks for B's", async () => {
    const draws = new Draws();
    draws.show("A");
    const drawn: string[] = [];
    const tools = later<string>();
    const a = draw(draws, drawn, tools.promise);
    // The window turns while A's tools are still being asked: no draw is for any workspace yet.
    expect(draws.show("B")).toBe(true);
    // Even before B's draw begins, A's late answer is not drawn.
    tools.settle("A");
    await a;
    expect(drawn).toEqual([]);
    await draw(draws, drawn, Promise.resolve("B"));
    expect(drawn).toEqual(["B: its cards"]);
  });

  it("asks for no new draw before any began, nor for the workspace the last is for", async () => {
    const draws = new Draws();
    expect(draws.show("A")).toBe(false);
    const drawn: string[] = [];
    await draw(draws, drawn, Promise.resolve("A"));
    expect(draws.show("A")).toBe(false);
    expect(drawn).toEqual(["A: its cards"]);
    expect(draws.show("")).toBe(true);
  });
});
