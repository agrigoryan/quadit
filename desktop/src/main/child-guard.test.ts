import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { childEnv, childStarter, GUARD_SCRIPT, withoutQuadit, withPath } from "@/main/child-guard";

const posixOnly = describe.skipIf(process.platform === "win32");
/** The sh guard, as the app starts programs on macOS and Linux. */
const startChild = childStarter(process.platform === "win32" ? "linux" : process.platform, () => null);

/** Whether the process `pid` still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `check` holds, for up to `ms`. */
async function until(check: () => boolean, ms = 5_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("it never held");
}

posixOnly("startChild", () => {
  it("runs a program with its arguments as given, line by line, and says how it ended", async () => {
    const lines: string[] = [];
    const child = startChild("/bin/sh", ["-c", 'echo "$1"; echo "$2" >&2; exit 3', "sh", "one; two", "$HOME"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      line: (line) => lines.push(line),
    });
    expect(await child.exited).toBe(3);
    expect(lines.sort()).toEqual(["$HOME", "one; two"]);
  });

  it("ends the program and all it started when stopped", async () => {
    const pids: number[] = [];
    const child = startChild("/bin/sh", ["-c", "sleep 30 & echo $!; echo $$; wait"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      line: (line) => pids.push(Number(line)),
    });
    await until(() => pids.length === 2);
    child.stop();
    await child.exited;
    await until(() => pids.every((pid) => !alive(pid)));
  });

  it("ends all the program started when the program ends by itself: nothing it started outlives it", async () => {
    const pids: number[] = [];
    const child = startChild("/bin/sh", ["-c", "sleep 30 & echo $!; exit 0"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      line: (line) => pids.push(Number(line)),
    });
    expect(await child.exited).toBe(0);
    await until(() => pids.length === 1 && pids.every((pid) => !alive(pid)));
  });

  it("ends a program that ignores being asked to stop, and is over only once it is gone", async () => {
    const pids: number[] = [];
    const child = startChild("/bin/sh", ["-c", "trap '' TERM; echo $$; while :; do sleep 0.1; done"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      line: (line) => pids.push(Number(line)),
    });
    await until(() => pids.length === 1);
    child.stop();
    await child.exited;
    expect(alive(pids[0] ?? 0)).toBe(false);
  }, 15_000);

  it("ends what a program left behind ignoring being asked to stop, once the program ended by itself", async () => {
    const pids: number[] = [];
    const child = startChild(
      "/bin/sh",
      ["-c", "sh -c \"trap '' TERM; while :; do sleep 0.1; done\" & echo $!; sleep 0.5; exit 0"],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        line: (line) => pids.push(Number(line)),
      },
    );
    expect(await child.exited).toBe(0);
    expect(pids).toHaveLength(1);
    expect(alive(pids[0] ?? 0)).toBe(false);
  }, 15_000);

  it("ends them too when the app is killed without a word, its end of the pipe closing", async () => {
    // A stand-in for the app: it starts a guarded child, says its pid, and is then killed hard.
    const app = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const guard = ${JSON.stringify(GUARD_SCRIPT)};
         const c = spawn("/bin/sh", ["-c", guard, "guard", "/bin/sh", "-c", "trap '' TERM; echo $$; while :; do sleep 0.1; done"], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
         c.stdout.on("data", (d) => process.stdout.write(d));`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const pid = await new Promise<number>((done) =>
      app.stdout.once("data", (d: Buffer) => done(Number(String(d).trim()))),
    );
    expect(alive(pid)).toBe(true);
    app.kill("SIGKILL");
    // Asked to stop, it does not: it is killed outright five seconds after.
    await until(() => !alive(pid), 10_000);
  }, 15_000);
});

/**
 * A stand-in for `quadit guard` (the Windows contract, S1), as a script
 * named `guard` in a folder of its own: Node started there with "guard"
 * first runs it, so the app's `quadit guard PROGRAM ARGS...` is played by
 * Node, on any system. As quadit's does, it starts nothing (exit 126)
 * unless the app's mark QUADIT_APP_GUARD=1 is in its environment, which it
 * does not pass on. It runs PROGRAM with ARGS as given, with no input, its
 * outputs passed through, exits with its code, and ends it when its own
 * input closes, unless GUARD_DEAF is set: then it never does.
 */
function fakeGuard(): string {
  const dir = mkdtempSync(join(tmpdir(), "quadit-desktop-guard-"));
  writeFileSync(
    join(dir, "guard"),
    `const { spawn } = require("node:child_process");
if (process.env.QUADIT_APP_GUARD !== "1") process.exit(126);
const [program, ...args] = process.argv.slice(2);
const env = { ...process.env };
delete env.QUADIT_APP_GUARD;
const child = spawn(program, args, { stdio: ["ignore", "inherit", "inherit"], env });
child.on("exit", (code) => process.exit(code ?? 1));
process.stdin.on("end", () => process.env.GUARD_DEAF || child.kill());
process.stdin.resume();
`,
  );
  return dir;
}

describe("startChild on Windows: quadit guard", () => {
  const start = childStarter("win32", () => process.execPath);

  it("starts quadit guard with the program and its arguments as given, line by line, and ends with the program's exit code", async () => {
    const lines: string[] = [];
    const child = start(
      process.execPath,
      [
        "-e",
        "console.log(process.argv.slice(1).join('|')); console.error(process.env.QUADIT_APP_GUARD ?? 'two'); process.exit(3)",
        "one; two",
        "$HOME",
        'say "hi"',
      ],
      { cwd: fakeGuard(), env: process.env, line: (line) => lines.push(line) },
    );
    expect(await child.exited).toBe(3);
    expect(lines.sort()).toEqual(['one; two|$HOME|say "hi"', "two"]);
  });

  it("stops the program by closing the guard's input", async () => {
    const lines: string[] = [];
    const child = start(process.execPath, ["-e", "console.log('up'); setInterval(() => {}, 1000)"], {
      cwd: fakeGuard(),
      env: process.env,
      line: (line) => lines.push(line),
    });
    await until(() => lines.includes("up"));
    child.stop();
    await child.exited;
  });

  it("starts the guard with the app's mark, whatever environment it is given", async () => {
    const lines: string[] = [];
    const child = start(process.execPath, ["-e", "console.log('ran')"], {
      cwd: fakeGuard(),
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
      line: (line) => lines.push(line),
    });
    expect(await child.exited).toBe(0);
    expect(lines).toEqual(["ran"]);
  });

  it("ends a guard still there once the time to stop is up, and only then", async () => {
    const lines: string[] = [];
    // A program that would outlast the test: only the guard ended outright ends the wait for it.
    const child = start(process.execPath, ["-e", "console.log(process.pid); setTimeout(() => {}, 60000)"], {
      cwd: fakeGuard(),
      env: { ...process.env, GUARD_DEAF: "1" },
      line: (line) => lines.push(line),
    });
    await until(() => lines.length === 1);
    const asked = Date.now();
    child.stop();
    try {
      await child.exited;
      const waited = Date.now() - asked;
      expect(waited).toBeGreaterThanOrEqual(5_000);
      expect(waited).toBeLessThan(10_000);
    } finally {
      // The stand-in guard, unlike quadit's, leaves its program behind when it is ended.
      process.kill(Number(lines[0]));
    }
  }, 15_000);

  it("starts nothing without a quadit of the app's, and says why", async () => {
    const lines: string[] = [];
    const child = childStarter("win32", () => null)("C:\\Tools\\claude.exe", ["-p", "hi"], {
      cwd: tmpdir(),
      env: {},
      line: (line) => lines.push(line),
    });
    expect(await child.exited).toBeNull();
    expect(lines).toEqual([
      "C:\\Tools\\claude.exe was not started: this Quadit app has no quadit command of its own to start it with.",
    ]);
  });
});

describe("childEnv", () => {
  it("gives a child the app's environment without the Quadit settings of the person's own servers, its own login and the login shell's PATH", () => {
    expect(
      childEnv(
        {
          PATH: "/usr/bin:/bin",
          HOME: "/h",
          OPENAI_API_KEY: "k",
          QUADIT_URL: "u",
          QUADIT_TOKEN: "t",
          QUADIT_CONFIG: "/x",
        },
        "/login.json",
        "/opt/homebrew/bin:/usr/bin:/bin",
      ),
    ).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: "/h",
      OPENAI_API_KEY: "k",
      QUADIT_CONFIG: "/login.json",
    });
  });
});

describe("withoutQuadit and withPath", () => {
  it("takes out every Quadit setting, on Windows whatever its case, as Windows reads the names", () => {
    const env = { Quadit_Token: "t", QUADIT_URL: "u", quadit_config: "c", HOME: "/h" };
    expect(withoutQuadit(env, "win32")).toEqual({ HOME: "/h" });
    // Elsewhere a name is its case: only QUADIT_ names are Quadit's.
    expect(withoutQuadit(env, "linux")).toEqual({ Quadit_Token: "t", quadit_config: "c", HOME: "/h" });
  });

  it("gives one PATH, on Windows every other spelling of it taken out, as Windows keeps it as Path", () => {
    const env = { Path: "C:\\Windows", PATHEXT: ".EXE", HOME: "/h" };
    expect(withPath(env, "C:\\Tools;C:\\Windows", "win32")).toEqual({
      PATHEXT: ".EXE",
      HOME: "/h",
      PATH: "C:\\Tools;C:\\Windows",
    });
    // Elsewhere Path is a variable of its own, kept.
    expect(withPath({ Path: "mine", PATH: "/bin" }, "/usr/bin:/bin", "darwin")).toEqual({
      Path: "mine",
      PATH: "/usr/bin:/bin",
    });
  });
});
