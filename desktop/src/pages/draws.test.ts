import { describe, expect, it } from "vitest";
import { Draws } from "@/pages/draws";

/** A promise settled from outside, to force the order answers come in. */
function later<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (settle = done));
  return { promise, settle };
}

describe("Draws", () => {
  it("drops a draw for A whose answer comes after the window turned to B and B was drawn", async () => {
    const draws = new Draws();
    const drawn: string[] = [];
    const handshakes = { A: later<string>(), B: later<string>() };
    // A draw as Connect agents makes one: the tools as seen from the workspace, then where each stands.
    const draw = async (workspace: "A" | "B") => {
      const d = draws.begin();
      d.isFor(workspace);
      const stands = await handshakes[workspace].promise;
      if (d.counts()) drawn.push(`${workspace}: ${stands}`);
    };

    const a = draw("A");
    // The window turns to B before A's handshake answered: B is to be drawn.
    expect(draws.stale("B")).toBe(true);
    const b = draw("B");
    handshakes.B.settle("B's card");
    await b;
    handshakes.A.settle("A's code");
    await a;
    expect(drawn).toEqual(["B: B's card"]);
    expect(draws.stale("B")).toBe(false);
  });

  it("asks for no new draw before the first knows its workspace, nor for the one it is for", () => {
    const draws = new Draws();
    expect(draws.stale("A")).toBe(false);
    const d = draws.begin();
    expect(draws.stale("A")).toBe(false);
    d.isFor("A");
    expect(draws.stale("A")).toBe(false);
    expect(draws.stale("")).toBe(true);
    expect(d.counts()).toBe(true);
  });
});
