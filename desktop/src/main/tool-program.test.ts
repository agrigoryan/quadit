import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESSES } from "@/main/harnesses";
import { toolProgram } from "@/main/tool-program";

const posixOnly = describe.skipIf(process.platform === "win32");

function harness(id: string) {
  const found = HARNESSES.find((h) => h.id === id);
  if (!found) throw new Error(id);
  return found;
}

/** A file at `path`, executable unless said, last changed `age` seconds ago. */
function program(path: string, { executable = true, age = 0 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, executable ? 0o755 : 0o644);
  const when = Date.now() / 1000 - age;
  utimesSync(path, when, when);
}

posixOnly("toolProgram", () => {
  const root = () => realpathSync(mkdtempSync(join(tmpdir(), "quadit-desktop-tool-")));

  it("is the tool's command on the login shell's PATH first", () => {
    const dir = root();
    program(join(dir, "bin", "codex"));
    program(join(dir, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"));
    expect(
      toolProgram(harness("codex"), {
        home: join(dir, "home"),
        path: [join(dir, "none"), join(dir, "bin")],
        applications: [join(dir, "Applications")],
      }),
    ).toBe(join(dir, "bin", "codex"));
  });

  it("else the copy the ChatGPT app carries for Codex", () => {
    const dir = root();
    const copy = join(dir, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
    program(copy);
    expect(
      toolProgram(harness("codex"), { home: join(dir, "home"), path: [], applications: [join(dir, "Applications")] }),
    ).toBe(copy);
  });

  it("else the newest copy the Claude app carries for Claude Code, a regular executable file", () => {
    const dir = root();
    const home = join(dir, "home");
    const base = join(home, "Library", "Application Support", "Claude", "claude-code");
    const at = (version: string, id: string) => join(base, version, id, "claude.app", "Contents", "MacOS", "claude");
    program(at("2.1.0", "a1"), { age: 300 });
    program(at("2.2.0", "b2"), { age: 10 });
    program(at("2.3.0", "c3"), { executable: false });
    mkdirSync(dirname(at("2.4.0", "d4")), { recursive: true });
    symlinkSync(join(dir, "nowhere"), at("2.4.0", "d4"));
    expect(toolProgram(harness("claude"), { home, path: [], applications: [] })).toBe(at("2.2.0", "b2"));
  });

  it("is none when the tool is nowhere, and for a tool without a one-prompt command", () => {
    const dir = root();
    expect(toolProgram(harness("codex"), { home: dir, path: [dir], applications: [dir] })).toBeNull();
    program(join(dir, "pi"));
    expect(toolProgram(harness("pi"), { home: dir, path: [dir], applications: [] })).toBeNull();
  });
});

describe("the one-prompt commands", () => {
  it("are argument lists, the prompt one argument whatever it holds", () => {
    const prompt = 'Connect to Quadit ABC234; rm -rf "$HOME"';
    expect(Object.fromEntries(HARNESSES.filter((h) => h.oneShot).map((h) => [h.id, h.oneShot?.(prompt)]))).toEqual({
      claude: ["-p", prompt],
      codex: ["exec", "--skip-git-repo-check", prompt],
      antigravity: ["-p", prompt, "--dangerously-skip-permissions"],
      cursor: ["-p", "--force", prompt],
    });
  });
});
