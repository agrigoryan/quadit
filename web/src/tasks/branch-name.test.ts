// A git branch name for a task (tasks/branch-name.ts).

import { describe, expect, it } from "vitest";
import { branchName } from "@/tasks/branch-name";

describe("branchName", () => {
  it("is the key in small letters, then the title's words joined by dashes", () => {
    expect(branchName({ key: "SVA-12", title: "Fix the login" })).toBe("sva-12-fix-the-login");
  });

  it("keeps only plain letters and digits, accents taken off", () => {
    expect(branchName({ key: "SVA-3", title: "  Café: résumé — v2.0 (beta)!  " })).toBe("sva-3-cafe-resume-v2-0-beta");
  });

  it("is the key alone when the title has no letters it can use", () => {
    expect(branchName({ key: "OPS-7", title: "Մուտքը չի աշխատում" })).toBe("ops-7");
  });

  it("cuts a long title at the end of a word", () => {
    const name = branchName({
      key: "SVA-12",
      title: "Make the import of very large spreadsheets resumable after a dropped connection",
    });
    expect(name).toBe("sva-12-make-the-import-of-very-large-spreadsheets");
    expect(name.length).toBeLessThanOrEqual(50);
  });
});
