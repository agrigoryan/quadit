import { describe, expect, it } from "vitest";
import { QuitGuard } from "@/main/quit";

/** A guard whose question is answered `answer`, the app in the background or not; it notes what it did. */
function guard(answer: "quit" | "stay", { background = false } = {}) {
  const said: string[] = [];
  const quit = new QuitGuard<string>({
    ask: () => {
      said.push("asked");
      return answer;
    },
    inBackground: () => background,
    stayed: () => void said.push("stayed"),
  });
  return { quit, said };
}

describe("QuitGuard", () => {
  it("leaves a page that holds on to itself alone when the app is not quitting: closing one window is no quit", () => {
    const { quit, said } = guard("quit");
    expect(quit.letGo("page")).toBe(false);
    expect(said).toEqual([]);
  });

  it("asks once for the whole quit, and Quit lets every page go", () => {
    const { quit, said } = guard("quit");
    quit.quitBegan();
    expect(quit.letGo("page")).toBe(true);
    expect(quit.letGo("page")).toBe(true);
    expect(said).toEqual(["asked"]);
  });

  it("Don't quit keeps every page and ends the quit, and a later quit asks again", () => {
    const { quit, said } = guard("stay");
    quit.quitBegan();
    expect(quit.letGo("page")).toBe(false);
    expect(quit.letGo("page")).toBe(false);
    expect(said).toEqual(["asked", "stayed"]);
    // No longer quitting: a window closed now is no quit.
    expect(quit.letGo("page")).toBe(false);
    quit.quitBegan();
    expect(quit.letGo("page")).toBe(false);
    expect(said).toEqual(["asked", "stayed", "asked", "stayed"]);
  });

  it("in the background, with nobody to answer, lets every page go without asking", () => {
    const { quit, said } = guard("stay", { background: true });
    quit.quitBegan();
    expect(quit.letGo("page")).toBe(true);
    expect(said).toEqual([]);
  });
});
