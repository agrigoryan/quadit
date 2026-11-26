import { describe, expect, it } from "vitest";
import { headingOf, openFor, waitsWords } from "@/pages/panel-words";

describe("the panel's words", () => {
  it("says how long a run has been open, in minutes, hours, then days", () => {
    const now = 10 * 24 * 3_600_000;
    expect(openFor(now - 10_000, now)).toBe("for 1m");
    expect(openFor(now - 3 * 60_000, now)).toBe("for 3m");
    expect(openFor(now - 2 * 3_600_000, now)).toBe("for 2h");
    expect(openFor(now - 125 * 60_000, now)).toBe("for 2h 5m");
    expect(openFor(now - 3 * 24 * 3_600_000, now)).toBe("for 3d");
  });

  it("says who a task waits on the person for", () => {
    expect(waitsWords("@codex")).toBe("@codex waits on you");
    expect(waitsWords("")).toBe("Waits on you");
  });

  it("names a workspace's block by the workspace, and its server only when there are several", () => {
    expect(headingOf("Harbor Studio", "This computer", 1)).toBe("Harbor Studio");
    expect(headingOf("Harbor Studio", "This computer", 2)).toBe("Harbor Studio on This computer");
  });
});
