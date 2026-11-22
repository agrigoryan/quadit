import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { childEnv, GUARD_SCRIPT, startChild } from "@/main/child-guard";

const posixOnly = describe.skipIf(process.platform === "win32");

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

  it("ends them too when the app is killed without a word, its end of the pipe closing", async () => {
    // A stand-in for the app: it starts a guarded child, says its pid, and is then killed hard.
    const app = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const guard = ${JSON.stringify(GUARD_SCRIPT)};
         const c = spawn("/bin/sh", ["-c", guard, "guard", "/bin/sh", "-c", "echo $$; exec sleep 30"], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
         c.stdout.on("data", (d) => process.stdout.write(d));`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const pid = await new Promise<number>((done) =>
      app.stdout.once("data", (d: Buffer) => done(Number(String(d).trim()))),
    );
    expect(alive(pid)).toBe(true);
    app.kill("SIGKILL");
    await until(() => !alive(pid));
  });
});

describe("childEnv", () => {
  it("gives a child the app's environment without the Quadit settings of the person's own servers, and its own login", () => {
    expect(
      childEnv({ PATH: "/bin", HOME: "/h", QUADIT_URL: "u", QUADIT_TOKEN: "t", QUADIT_CONFIG: "/x" }, "/login.json"),
    ).toEqual({ PATH: "/bin", HOME: "/h", QUADIT_CONFIG: "/login.json" });
  });
});
