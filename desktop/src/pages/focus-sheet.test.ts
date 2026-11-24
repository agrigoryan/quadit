import { describe, expect, it } from "vitest";
import { sheetOf, type SheetTool } from "@/pages/focus-sheet";

const tools: SheetTool[] = [
  { id: "claude", found: true, setUp: true, defaultLogin: false },
  { id: "codex", found: true, setUp: false, defaultLogin: false },
  { id: "gemini", found: true, setUp: false, defaultLogin: true },
  { id: "cursor", found: false, setUp: false, defaultLogin: false },
];
const HELPER = { id: "u9", handle: "helper" };

describe("sheetOf", () => {
  it("holds the card of the tool that works as the agent, for each intent", () => {
    for (const intent of ["run", "disconnect", "connect"] as const)
      expect(sheetOf({ id: 1, intent, tool: "claude" }, tools, "this Mac")).toEqual({
        tools: ["claude"],
        line: null,
        intent,
        connectAs: null,
      });
    expect(sheetOf({ id: 1, tool: "claude" }, tools, "this Mac")?.intent).toBe("connect");
  });

  it("with none, to connect, says the agent and holds only the cards that could work as it", () => {
    expect(sheetOf({ id: 1, intent: "connect", agent: HELPER }, tools, "this Mac")).toEqual({
      tools: ["codex"],
      line: "Choose what should work as @helper on this Mac.",
      intent: "connect",
      connectAs: HELPER,
    });
    const busy = tools.map((t) => ({ ...t, setUp: true }));
    expect(sheetOf({ id: 1, intent: "connect", agent: HELPER }, busy, "this computer")).toMatchObject({
      tools: [],
      line: "No AI tool found on this computer is free to work as @helper.",
    });
  });

  it("is none, and the whole page shows, without a focus, or with nothing to show for it", () => {
    expect(sheetOf(undefined, tools, "this Mac")).toBeNull();
    expect(sheetOf({ id: 1, intent: "run", agent: HELPER }, tools, "this Mac")).toBeNull();
    expect(sheetOf({ id: 1, intent: "connect", tool: "opencode" }, tools, "this Mac")).toBeNull();
  });
});
