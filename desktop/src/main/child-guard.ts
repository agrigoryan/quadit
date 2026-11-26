// The programs the app starts besides its server (a tool run once to give
// its connect code back: self-runs.ts; quadit run: runner.ts), held so that
// none outlives the app, under a guard that ends a program and all it
// started together: when the app stops it, when it ends by itself (nothing
// it started outlives it), and when the app quits or is killed without a
// word (the app's end of the guard's standard input closes). Asked to stop,
// they have five seconds before they are ended outright.
//
// On macOS and Linux the guard is a small POSIX sh, in a process group of
// its own, which is what is signalled (SIGTERM, then SIGKILL). What it
// cannot promise: a program that leaves its group (setsid). Windows has no
// sh, no process groups and no signals the app can send: there the guard is
// `quadit guard PROGRAM ARGS...` of the quadit the app carries (the Windows
// contract, S1), stopped by closing its standard input; its exit code is
// the program's, 127 when the program is not found and 126 when the guard
// refuses it (a path or an argument holding ", % or a control character,
// which cmd.exe could read anew; a .ps1, or a file without an extension).
// Each program gets a hidden console of its own there, and an agent's run
// that is stopped is ended at once, with nothing gentler first.
//
// A child gets no terminal and no window of the app's; it gets the login
// shell's PATH and none of the app's QUADIT_ settings (childEnv).

import { spawn } from "node:child_process";
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

/** How long a group asked to stop has before it is killed outright, and how long after that the app waits at most. */
const STOP_GRACE_MS = 5_000;
const KILL_WAIT_MS = 2_000;

/** A program the app started: its end (its exit code, null when a signal ended it), and the way to stop it. */
export interface RunningChild {
  exited: Promise<number | null>;
  /** Ends the program and all it started. */
  stop(): void;
}

/** What a started program is given besides its arguments: its working folder, its environment, and where each line it writes goes. */
export interface ChildOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  line: (line: string) => void;
}

/**
 * Starts `program` with `args` (never through a shell of its own: each
 * argument is given as it is) under the guard, in `cwd` with `env`; each
 * line it writes, on either output, goes to `line`. Its end comes once all
 * it started is gone.
 */
export type StartChild = (program: string, args: string[], options: ChildOptions) => RunningChild;

/**
 * The way the app starts the programs it holds on `platform`: under the sh
 * guard, or on Windows under `quadit guard` of `quadit` (the quadit the app
 * carries). Without one there, nothing can be started: the start ends at
 * once, saying why.
 */
export function childStarter(platform: NodeJS.Platform, quadit: () => string | null): StartChild {
  if (platform !== "win32") return startUnderSh;
  return (program, args, options) => {
    const guard = quadit();
    if (guard) return startUnderQuadit(guard, program, args, options);
    options.line(`${program} was not started: this Quadit app has no quadit command of its own to start it with.`);
    return { exited: Promise.resolve(null), stop: () => {} };
  };
}

/** The sh guard (macOS, Linux): the program in a process group of its own, which is what is ended. */
function startUnderSh(program: string, args: string[], options: ChildOptions): RunningChild {
  // detached: a process group of its own, which is what is ended (never the app's).
  const child = spawn("/bin/sh", ["-c", GUARD_SCRIPT, "quadit-app", program, ...args], {
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
  return { exited, stop: () => void end() };
}

/**
 * `quadit guard PROGRAM ARGS...` (Windows): the guard ends the program and
 * all it started when its input closes, asking first and ending them
 * outright five seconds later, and when it is itself ended. Stopping closes
 * its input; a guard still there once that time is up is ended outright.
 */
function startUnderQuadit(quadit: string, program: string, args: string[], options: ChildOptions): RunningChild {
  // No console window: the app is a window program, and a console program it starts would get one of its own.
  const child = spawn(quadit, ["guard", program, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", options.line);
  child.stdin.on("error", () => {});
  let gone = false;
  const exited = new Promise<number | null>((done) => {
    child.once("exit", (code) => done(code));
    child.once("error", () => done(null));
  }).finally(() => (gone = true));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.stdin.end();
    const late = setTimeout(() => gone || child.kill(), STOP_GRACE_MS + KILL_WAIT_MS);
    void exited.then(() => clearTimeout(late));
  };
  return { exited, stop };
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
  const kept = withoutQuadit(env);
  return { ...(path ? withPath(kept, path) : kept), QUADIT_CONFIG: login };
}

/**
 * `env` without any QUADIT_ setting: the person's own servers' address and
 * token never reach what the app runs. Matched in any case, as Windows
 * matches the names of variables.
 */
export function withoutQuadit(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("QUADIT_")));
}

/**
 * `env` with `path` as its PATH. Windows matches the names of variables in
 * any case and keeps this one as "Path": every spelling of it goes first, or
 * the program would be given two and see either.
 */
export function withPath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH")), PATH: path };
}
