// The programs the app starts besides its server (a tool run once to give
// its connect code back, a tool's listener: self-runs.ts), held so that none
// outlives the app. Each runs under a small POSIX sh, the guard, in a process
// group of its own, and ends with the whole group: when the app stops it,
// when it ends by itself (nothing it started outlives it), and when the app
// quits or is killed without a word (the app's end of the guard's standard
// input closes). The group is asked to stop (SIGTERM) and, still there five
// seconds later, killed outright. What it cannot promise: a program that
// leaves its group (setsid).
//
// A listener's report (`quadit listen events=FILE`) comes in a file the app
// makes and reads, which the tool's output never reaches.
//
// A child gets no terminal and no window of the app's; it gets the login
// shell's PATH and none of the app's QUADIT_ settings (childEnv).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * The guard. A reader holds its standard input (fd 3; an asynchronous list
 * in sh reads /dev/null unless told otherwise): when it ends (the app gone),
 * the reader ends the group, killing it outright five seconds after; asked
 * to stop with the group, the reader just goes. Then "$@" runs, without that
 * input; when it ends, the guard asks the rest of its group to stop, and the
 * app finishes it (startChild).
 */
export const GUARD_SCRIPT = `exec 3<&0
( trap 'exit 0' TERM; while read -r _; do :; done; trap '' TERM; kill -TERM 0; sleep 5; kill -KILL 0 ) <&3 &
"$@" </dev/null 3<&- &
child=$!
exec 3<&-
wait "$child"
status=$?
trap '' TERM
kill -TERM 0 2>/dev/null
exit "$status"`;

/** The argument a program is given in place of which startChild puts the path of the events file it reads. */
export const EVENTS_FILE = "{events-file}";

/** How long a group asked to stop has before it is killed outright, and how long after that the app waits at most. */
const STOP_GRACE_MS = 5_000;
const KILL_WAIT_MS = 2_000;

/** A program the app started: its end (its exit code, null when a signal ended it), and the way to stop it. */
export interface RunningChild {
  exited: Promise<number | null>;
  /** Ends the program and all it started. */
  stop(): void;
}

/**
 * Starts `program` with `args` (never through a shell of its own: each
 * argument is given as it is) under the guard, in `cwd` with `env`; each
 * line it writes, on either output, goes to `line`. With `events`, an
 * argument EVENTS_FILE is given as the path of a file the app makes, each
 * line written to it going to `events`. Its end comes once its whole group
 * is gone.
 */
export function startChild(
  program: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    line: (line: string) => void;
    events?: (line: string) => void;
  },
): RunningChild {
  const heard = options.events ? eventsFile(options.cwd, options.events) : null;
  const given = heard ? args.map((arg) => arg.replace(EVENTS_FILE, heard.path)) : args;
  // detached: a process group of its own, which is what is ended (never the app's).
  const child = spawn("/bin/sh", ["-c", GUARD_SCRIPT, "quadit-app", program, ...given], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", options.line);
  // A guard already gone has no input to close: nothing to say.
  child.stdin.on("error", () => {});
  let ending: Promise<void> | null = null;
  const end = () => (ending ??= child.pid ? endGroup(child.pid) : Promise.resolve());
  const exited = new Promise<number | null>((done) => {
    child.once("exit", (code) => void end().then(() => done(code)));
    child.once("error", () => done(null));
  });
  void exited.then(() => heard?.close());
  return { exited, stop: () => void end() };
}

/** Whether any process of the group `pgid` is left. */
function groupLeft(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Asks the group `pgid` to stop, kills it outright after STOP_GRACE_MS, and resolves once it is gone. */
async function endGroup(pgid: number): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pgid, name);
    } catch {
      // Gone already.
    }
  };
  signal("SIGTERM");
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const killAt = Date.now() + STOP_GRACE_MS;
  while (groupLeft(pgid) && Date.now() < killAt) await wait(50);
  if (!groupLeft(pgid)) return;
  signal("SIGKILL");
  for (const giveUp = Date.now() + KILL_WAIT_MS; groupLeft(pgid) && Date.now() < giveUp;) await wait(50);
}

/**
 * The environment a child gets: the app's, without any QUADIT_ setting (the
 * person's own servers' URL and token), with `login` as its quadit login and
 * the login shell's PATH (`path`: an app started from the Dock has a short
 * one, and the tool must find quadit and its own helpers). Every other
 * variable is kept: a tool may need its own keys.
 */
export function childEnv(env: NodeJS.ProcessEnv, login: string, path?: string): NodeJS.ProcessEnv {
  return { ...withoutQuadit(env), ...(path ? { PATH: path } : {}), QUADIT_CONFIG: login };
}

/** `env` without any QUADIT_ setting: the person's own servers' address and token never reach what the app runs. */
export function withoutQuadit(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("QUADIT_")));
}

/**
 * A file in `dir`, only the person's to read, a program appends lines to,
 * each new line handed to `heard` as it comes; `close` reads what is left
 * and takes the file away.
 */
function eventsFile(dir: string, heard: (line: string) => void): { path: string; close(): void } {
  const path = join(dir, `.quadit-events-${randomBytes(6).toString("hex")}`);
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
