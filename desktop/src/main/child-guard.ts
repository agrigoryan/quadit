// The programs the app starts besides its server (a tool run once to give
// its connect code back, a tool's listener: self-runs.ts), held so that none
// outlives the app. Each runs under a small POSIX sh, the guard, in a process
// group of its own: when the app's end of the guard's standard input closes,
// the guard ends the whole group, the program and whatever it started. The
// app closes it to stop a program; the system closes it when the app quits
// or is killed without a word. What it cannot promise: a program that leaves
// its group (setsid) or ignores SIGTERM.
//
// A child gets no terminal, no window of the app's, and none of the app's
// QUADIT_ settings (childEnv): the login it uses is its own.

import { spawn } from "node:child_process";
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
reader=$!
exec 3<&-
wait "$child"
status=$?
kill "$reader" 2>/dev/null
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
 * line it writes, on either output, goes to `line`.
 */
export function startChild(
  program: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; line: (line: string) => void },
): RunningChild {
  // detached: a process group of its own, which is what the guard ends (never the app's).
  const child = spawn("/bin/sh", ["-c", GUARD_SCRIPT, "quadit-app", program, ...args], {
    cwd: options.cwd,
    env: options.env,
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
  return { exited, stop: () => child.stdin.end() };
}

/** The environment a child gets: the app's, without any QUADIT_ setting, with `login` as its quadit login. */
export function childEnv(env: NodeJS.ProcessEnv, login: string): NodeJS.ProcessEnv {
  const own = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("QUADIT_")));
  return { ...own, QUADIT_CONFIG: login };
}
