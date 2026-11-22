import { describe, expect, it } from "vitest";
import { countWord, diskLine, fileWords, filesSummary, sheetIntro, unrevokedWords } from "@/shared/change-words";

describe("fileWords for a tool's command rules", () => {
  it("names the rules file and its folder plainly", () => {
    expect(fileWords({ role: "rules", change: "new" }, "Codex")).toEqual({
      title: "Codex’s command rules",
      what: "Lets Codex run quadit without asking you each time.",
      chip: "New file",
    });
    expect(fileWords({ role: "rules", change: "edited" }, "Codex").chip).toBe("Added to");
    expect(fileWords({ role: "rules-folder", change: "new" }, "Codex")).toEqual({
      title: "A folder for Codex’s command rules",
      what: "Made where Codex looks for them.",
      chip: "New folder",
    });
  });
});

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
  it("says in a few words that connecting lets a tool run quadit without asking, where it has settings for that", () => {
    const codex = { name: "Codex", ownLogin: true, worksAs: null, allows: true };
    expect(diskLine(codex, false, false)).toBe(
      "Adds the Quadit skill and a login file for this tool, and lets Codex run quadit without asking. Nothing else is touched; a backup is kept.",
    );
    expect(diskLine(codex, false, true)).toBe(
      "Added the Quadit skill and a login file, and let Codex run quadit without asking. A backup of everything is kept.",
    );
  });

  it("says what connecting a tool with a login of its own adds, and that nothing else is touched", () => {
    expect(diskLine({ name: "Cursor", ownLogin: true, worksAs: null, allows: false }, false, false)).toBe(
      "Adds the Quadit skill and a login file for this tool. Nothing else is touched; a backup is kept.",
    );
    expect(diskLine({ name: "Cursor", ownLogin: true, worksAs: null, allows: false }, false, true)).toBe(
      "Added the Quadit skill and a login file. A backup of everything is kept.",
    );
  });

  it("names the quadit command when the computer has none yet, and the computer's login for a tool without its own", () => {
    expect(diskLine({ name: "Cursor", ownLogin: true, worksAs: null, allows: false }, true, false)).toBe(
      "Adds the quadit command, the Quadit skill and a login file for this tool. Nothing else is touched; a backup is kept.",
    );
    expect(diskLine({ name: "Cursor", ownLogin: false, worksAs: null, allows: false }, false, false)).toBe(
      "Adds the Quadit skill; it signs in with this computer’s Quadit login. Nothing else is touched; a backup is kept.",
    );
  });

  it("says whom a tool without a login of its own works as, when this computer's login is there already", () => {
    expect(
      diskLine({ name: "Cursor", ownLogin: false, worksAs: "@ann on https://q.example", allows: false }, false, true),
    ).toBe(
      "Added the Quadit skill; it works as @ann on https://q.example, this computer’s Quadit login. A backup of everything is kept.",
    );
  });
});

describe("sheetIntro", () => {
  it("says the tool gets a login of its own only when the plan makes one", () => {
    expect(sheetIntro("Codex", [{ role: "skill" }, { role: "login" }])).toContain("a login of its own");
    expect(sheetIntro("pi", [{ role: "skill" }, { role: "shared-login" }])).toContain("this computer’s Quadit login");
  });
});

describe("unrevokedWords", () => {
  it("says what happened, then what to do and where, by the token's name, and keeps the server's reason apart", () => {
    const unrevoked = {
      label: "Claude Code on mac",
      agent: "claude-code",
      server: "This computer",
      reason: "Token revocation was refused",
    };
    expect(unrevokedWords(unrevoked, "Claude Code")).toEqual({
      happened: "Claude Code is disconnected, but its key to this workspace could not be taken back.",
      todo: "To take it back, open Quadit (This computer), go to Settings → Agents → @claude-code, and under Tokens revoke “Claude Code on mac”.",
      reason: "The server said: Token revocation was refused.",
    });
  });
});
