// The line that resumes a run's session in a terminal
// (insights/agents/resume-line.ts): built only from a canonical session id
// and a folder label of the strict form, the folder one quoted shell word
// whatever its label holds, with only a leading ~/ left for the shell.

import { describe, expect, it } from "vitest";
import { resumeLine, shellFolder } from "@/insights/agents/resume-line";

const id = "0f8e7d6c-5b4a-4321-9fed-cba987654321";

describe("resumeLine", () => {
  it("changes to the folder and resumes the session the way each program does", () => {
    expect(resumeLine({ program: "claude", program_session: id, folder: "~/devel/game" })).toBe(
      `cd ~/'devel/game' && claude --resume ${id}`,
    );
    expect(resumeLine({ program: "codex", program_session: id, folder: "/srv/game" })).toBe(
      `cd '/srv/game' && codex resume ${id}`,
    );
  });

  it("shows no command for a session id that is not a canonical UUID", () => {
    for (const session of [
      "",
      "0F8E7D6C-5B4A-4321-9FED-CBA987654321",
      `${id}; rm -rf ~`,
      `{${id}}`,
      "0f8e7d6c5b4a43219fedcba987654321",
      `${id}\n`,
    ])
      expect(resumeLine({ program: "claude", program_session: session, folder: "~/devel/game" })).toBeNull();
  });

  it("shows no command for a program it does not know, or a folder not of its form", () => {
    expect(resumeLine({ program: "gemini", program_session: id, folder: "~/devel/game" })).toBeNull();
    expect(resumeLine({ program: "constructor", program_session: id, folder: "~/devel/game" })).toBeNull();
    expect(resumeLine({ program: "claude", program_session: id, folder: "devel/game" })).toBeNull();
    expect(resumeLine({ program: "claude", program_session: id })).toBeNull();
  });
});

describe("shellFolder", () => {
  it("leaves a leading ~/ to the shell and quotes the rest as one word", () => {
    expect(shellFolder("~")).toBe("~");
    expect(shellFolder("~/game")).toBe("~/'game'");
    expect(shellFolder("/")).toBe("'/'");
  });

  it("quotes a label that would mean something to the shell, so it is only a name", () => {
    expect(shellFolder("~/it's mine")).toBe(`~/'it'\\''s mine'`);
    expect(shellFolder("~/my games/boss fight")).toBe("~/'my games/boss fight'");
    expect(shellFolder("~/$(rm -rf ~)")).toBe("~/'$(rm -rf ~)'");
    expect(shellFolder("~/`reboot`")).toBe("~/'`reboot`'");
    expect(shellFolder("/tmp/a; rm -rf ~")).toBe("'/tmp/a; rm -rf ~'");
    expect(shellFolder("/a && b | c > d")).toBe("'/a && b | c > d'");
    expect(shellFolder('/say "hi" $HOME')).toBe(`'/say "hi" $HOME'`);
    expect(shellFolder("~/-rf")).toBe("~/'-rf'");
  });

  it("quotes ~ followed by a name, which the shell would read as another person's home", () => {
    expect(shellFolder("~root/x")).toBe("'~root/x'");
  });

  it("refuses a label with a control character, an empty part, or not starting at ~ or /", () => {
    for (const label of [
      "",
      "-rf",
      "devel/game",
      "~/a\nrm -rf ~",
      "/a\rb",
      "/a\tb",
      "/a\u0000b",
      "/a\u001bb",
      "~//game",
      "/a//b",
      "~/game/",
      "//",
    ])
      expect(shellFolder(label)).toBeNull();
  });
});
