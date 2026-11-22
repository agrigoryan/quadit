// The programs the app starts besides its server (a tool run once to give
// its connect code back, a tool's listener: self-runs.ts), held so that none
// outlives the app. Each runs under a small POSIX sh, the guard, in a process
// group of its own: when the app's end of the guard's standard input closes,
// the guard ends the whole group, the program and whatever it started. The
// app closes it to stop a program; the system closes it when the app quits
// or is killed without a word. When the program ends by itself, the guard
// ends the rest of its group too: nothing it started outlives it. What it
// cannot promise: a program that leaves its group (setsid) or ignores
// SIGTERM.
//
// What a program says of itself (a run started or ended) comes on a channel
// its output cannot write to: a file named in QUADIT_APP_LIFECYCLE, which
// the app reads, and which the program hands on to nothing it runs.
//
// A child gets no terminal and no window of the app's; it gets the login
// shell's PATH and none of the app's QUADIT_ settings (childEnv).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * The guard: runs "$@" in the background, reads its own standard input
 * until it ends, then ends its process group; or exits with the program's
 * status when the program ends first. An asynchronous list in sh reads
 * /dev/null unless told otherwise, so the reader is given the guard's input
 * (fd 3) explicitly, and the program is not.
 */
export const GUARD_SCRIPT = `exec 3<&0
"$@" </dev/null 3<&- &
child=$!
( while read -r _; do :; done; kill -TERM 0 ) <&3 &
exec 3<&-
wait "$child"
status=$?
trap '' TERM
kill -TERM 0 2>/dev/null
exit "$status"`;

/** A program the app started: its end (its exit code, null when a signal ended it), and the way to stop it. */
export interface RunningChild {
  exited: Promise<number | null>;
  /** Ends the program and all it started. */
  stop(): void;
}

/**
 * Starts `program` with `args` (never through a shell of its own: each
 * argument is given as it is) under the guard, in `cwd` with `env`; each
 * line it writes, on either output, goes to `line`, and each line it writes
 * to the file in QUADIT_APP_LIFECYCLE to `lifecycle`, when given.
 */
export function startChild(
  program: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    line: (line: string) => void;
    lifecycle?: (event: string) => void;
  },
): RunningChild {
  const heard = options.lifecycle ? lifecycleFile(options.cwd, options.lifecycle) : null;
  // detached: a process group of its own, which is what the guard ends (never the app's).
  const child = spawn("/bin/sh", ["-c", GUARD_SCRIPT, "quadit-app", program, ...args], {
    cwd: options.cwd,
    env: heard ? { ...options.env, QUADIT_APP_LIFECYCLE: heard.path } : options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", options.line);
  // A guard already gone has no input to close: nothing to say.
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((done) => {
    child.once("exit", (code) => done(code));
    child.once("error", () => done(null));
  });
  void exited.then(() => heard?.close());
  return { exited, stop: () => child.stdin.end() };
}

/**
 * The environment a child gets: the app's, without any QUADIT_ setting (the
 * person's own servers' URL and token), with `login` as its quadit login and
 * the login shell's PATH (`path`: an app started from the Dock has a short
 * one, and the tool must find quadit and its own helpers). Every other
 * variable is kept: a tool may need its own keys.
 */
export function childEnv(env: NodeJS.ProcessEnv, login: string, path?: string): NodeJS.ProcessEnv {
  const own = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("QUADIT_")));
  return { ...own, ...(path ? { PATH: path } : {}), QUADIT_CONFIG: login };
}

/**
 * A file in `dir` a program appends lines to, each new line handed to
 * `heard` as it comes; `close` reads what is left and takes the file away.
 */
function lifecycleFile(dir: string, heard: (line: string) => void): { path: string; close(): void } {
  const path = join(dir, `.quadit-lifecycle-${randomBytes(6).toString("hex")}`);
  writeFileSync(path, "", { mode: 0o600 });
  let at = 0;
  let rest = "";
  const read = () => {
    const fd = openSync(path, "r");
    try {
      const chunk = Buffer.alloc(64 * 1024);
      for (let n; (n = readSync(fd, chunk, 0, chunk.length, at)) > 0; at += n) rest += chunk.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line) heard(line);
  };
  const watcher = watch(path, () => read());
  return {
    path,
    close: () => {
      watcher.close();
      read();
      rmSync(path, { force: true });
    },
  };
}
