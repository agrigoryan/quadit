import { describe, expect, it } from "vitest";
import { countWord, diskLine, fileWords, filesSummary, sheetIntro } from "@/shared/change-words";

describe("fileWords", () => {
  it("says what each kind of file is for, in plain words, with what happens to it", () => {
    expect(fileWords({ role: "skill", change: "new" }, "Claude Code")).toEqual({
      title: "The Quadit skill",
      what: "Teaches Claude Code how to find tasks, ask you and report back.",
      chip: "New file",
    });
    expect(fileWords({ role: "login", change: "new" }, "Codex")).toEqual({
      title: "A login for Codex",
      what: "Its own key to this workspace. You can take it back any time.",
      chip: "New file",
    });
    expect(fileWords({ role: "settings", change: "edited" }, "Claude Code")).toMatchObject({
      title: "Claude Code’s settings",
      chip: "Added to",
    });
    expect(fileWords({ role: "shared-login", change: "edited" }, "Cursor").what).toBe(
      "Cursor has no setting for a login of its own, so it uses this one.",
    );
  });

  it("names the quadit command's link, its folder and the profile line for what they are", () => {
    expect(fileWords({ role: "command", change: "new" }, "pi")).toMatchObject({
      title: "The quadit command",
      chip: "New link",
    });
    expect(fileWords({ role: "folder", change: "new" }, "pi").chip).toBe("New folder");
    expect(fileWords({ role: "profile", change: "edited" }, "pi")).toMatchObject({
      title: "Your terminal’s start-up file",
      chip: "One line added",
    });
  });

  it("says a disconnect takes a file away or puts it back", () => {
    expect(fileWords({ role: "skill", change: "removed" }, "Codex").chip).toBe("Taken away");
    expect(fileWords({ role: "settings", change: "restored" }, "Codex").chip).toBe("Put back");
  });
});

describe("filesSummary", () => {
  it("counts the files in words, and says when they are all in the home folder", () => {
    expect(
      filesSummary([
        { shown: "~/.claude/skills/quadit/SKILL.md" },
        { shown: "~/.claude/settings.json" },
        { shown: "~/x" },
      ]),
    ).toBe("Three files in your home folder");
    expect(filesSummary([{ shown: "/etc/profile" }])).toBe("One file on this computer");
    expect(filesSummary([])).toBe("No files on this computer");
  });
});

describe("countWord", () => {
  it("writes small counts as words and larger ones in digits", () => {
    expect(countWord(2)).toBe("two");
    expect(countWord(11)).toBe("11");
  });
});

describe("diskLine", () => {
  it("says what connecting a tool with a login of its own adds, and that nothing else is touched", () => {
    expect(diskLine({ ownLogin: true }, false, false)).toBe(
      "Adds the Quadit skill and a login file for this tool. Nothing else is touched; a backup is kept.",
    );
    expect(diskLine({ ownLogin: true }, false, true)).toBe(
      "Added the Quadit skill and a login file. A backup of everything is kept.",
    );
  });

  it("names the quadit command when the computer has none yet, and the computer's login for a tool without its own", () => {
    expect(diskLine({ ownLogin: true }, true, false)).toBe(
      "Adds the quadit command, the Quadit skill and a login file for this tool. Nothing else is touched; a backup is kept.",
    );
    expect(diskLine({ ownLogin: false }, false, false)).toBe(
      "Adds the Quadit skill; it signs in with this computer’s Quadit login. Nothing else is touched; a backup is kept.",
    );
  });
});

describe("sheetIntro", () => {
  it("says the tool gets a login of its own only when the plan makes one", () => {
    expect(sheetIntro("Codex", [{ role: "skill" }, { role: "login" }])).toContain("a login of its own");
    expect(sheetIntro("pi", [{ role: "skill" }, { role: "shared-login" }])).toContain("this computer’s Quadit login");
  });
});
