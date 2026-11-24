// The app's side of `quadit run` (agent-runs-contract.md §5, §8.3): the one
// process on this computer that starts an agent's program for a task,
// serving every entry of the computer's registry (runner.json, in the
// folder of the quadit logins). The app never writes the registry: it asks
// the runner's own commands, `quadit run add`, `remove` and `list --json`,
// of the quadit it carries, whose version is the app's, so that the
// registry's form and the commands' words match.
//
// Supervision: `quadit run` runs under the guard (child-guard.ts), with the
// login shell's PATH (the programs it starts are found on it) and none of
// the app's QUADIT_ settings (its registry is then the default one). It is
// started at the app's start when the registry has an entry, after an add,
// and so after an update of the app, which is a new process. Ended by
// itself, it is started again after 2 s, doubling to 5 minutes, back to 2 s
// once it ran a minute; ended because another quadit run serves this
// computer (exit 3, one started by hand), it is not, and the app tries
// again every 5 minutes. It is stopped when the last entry goes and at quit,
// never waited for: the runner ends its programs on the guard's SIGTERM,
// within the guard's grace.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunningChild, startChild } from "@/main/child-guard";
import { withoutQuadit } from "@/main/child-guard";
import { homely } from "@/main/connections";
import type { Refused, RunEntryView, RunPause, RunProgram } from "@/shared/pages-api";

export interface RunnerParts {
  /** The quadit the app carries (its version is the app's); null in a build without one. */
  quadit: () => string | null;
  /** The login shell's PATH. */
  path: () => Promise<string>;
  /** The app's environment; the runner gets it without QUADIT_ settings (withoutQuadit). */
  env: NodeJS.ProcessEnv;
  /** Starts a program, held to the app (child-guard.ts). */
  start: typeof startChild;
  /** The app's log of the runner: what it printed, and when it was started and why it ended. */
  log: (line: string) => void;
  /** What a card shows of the runner changed. */
  changed: () => void;
}

/** One entry as `quadit run list --json` gives it (§5.2), with its status (§5.12) while a runner serves. */
interface Listed {
  id: string;
  login: string;
  project: string;
  folder: string;
  program: string;
  removing?: boolean;
  status?: {
    state?: string;
    task?: string;
    pause?: string;
    until?: string;
    message?: string;
    blocked?: { task?: string; error?: string }[];
  };
}

/** What `quadit run list --json` says: whether a runner serves the registry now, and its entries. */
export interface RunList {
  serving: boolean;
  entries: Listed[];
}

/** The exit of a `quadit run` that found another serving this computer (§5.2, G9). */
const ANOTHER_SERVES = 3;
/** The waits before starting the runner again after it ended by itself: from the first, doubling, to the last. */
const FIRST_WAIT_MS = 2_000;
const LAST_WAIT_MS = 5 * 60_000;
/** A runner that ran this long before it ended gets its waits back from the first. */
const STEADY_MS = 60_000;
/** How often the app tries again while another quadit run serves this computer. */
const ANOTHER_WAIT_MS = 5 * 60_000;
/** How long a command may take: add checks the server and the program (10 s each); remove waits up to 60 s for a serving runner. */
const COMMAND_MS = 20_000;
const ADD_MS = 60_000;
const REMOVE_MS = 90_000;

const PAUSES: readonly string[] = [
  "usage_limit",
  "not_signed_in",
  "program_missing",
  "folder_missing",
  "login_mismatch",
  "server_old",
] satisfies RunPause[];

/** The card's lines for entries no runner of the app's serves now. */
export const NOT_SERVED = {
  another: "Another quadit run serves this computer.",
  restarting: "Not running. Quadit starts it again in a moment.",
  stopped: "Not running.",
};

const NO_QUADIT: Refused = { ok: false, error: "This Quadit app has no quadit command of its own to run agents with." };

export class Runner {
  private child: RunningChild | null = null;
  /** When the runner running now was started. */
  private since = 0;
  /** How many times in a row it ended by itself soon after its start. */
  private waits = 0;
  /** The next start: after it ended by itself, or while another serves this computer. */
  private next: ReturnType<typeof setTimeout> | undefined;
  /** Its last end said another quadit run serves this computer. */
  private another = false;
  private beginning = false;
  private quitting = false;
  /** The list being read, shared by whoever asks meanwhile (every shown card asks every 2 s). */
  private listing: Promise<RunList> | null = null;
  /** What the last failed read of the list said, logged once. */
  private listFailed = "";

  constructor(private parts: RunnerParts) {}

  /** Whether the app can run agents at all: it carries a quadit. */
  get available(): boolean {
    return this.parts.quadit() !== null;
  }

  /** The entries and their status: `quadit run list --json`. */
  list(): Promise<RunList> {
    this.listing ??= this.readList().finally(() => (this.listing = null));
    return this.listing;
  }

  private async readList(): Promise<RunList> {
    const said = await this.run(["run", "list", "--json"], COMMAND_MS);
    if (said.code !== 0) throw new Error(said.words);
    const raw = JSON.parse(said.out) as { serving?: unknown; entries?: unknown };
    const entries = Array.isArray(raw.entries) ? (raw.entries as Partial<Listed>[]) : [];
    return {
      serving: raw.serving === true,
      entries: entries.filter(
        (e): e is Listed =>
          typeof e === "object" &&
          e !== null &&
          [e.id, e.login, e.project, e.folder, e.program].every((v) => typeof v === "string"),
      ),
    };
  }

  /**
   * The entries of the login `login` (an agent's own login file) and what
   * each does now, as its card says them; none when the list cannot be read.
   */
  async entries(login: string): Promise<RunEntryView[]> {
    let list: RunList;
    try {
      list = await this.list();
      this.listFailed = "";
    } catch (err) {
      const words = (err as Error).message;
      if (words !== this.listFailed) this.parts.log(`quadit run list: ${words}`);
      this.listFailed = words;
      return [];
    }
    const home = this.parts.env.HOME ?? "";
    return list.entries.flatMap((e) =>
      sameFile(e.login, login) && (e.program === "claude" || e.program === "codex")
        ? [
            {
              id: e.id,
              project: e.project,
              folder: homely(home, e.folder),
              program: e.program,
              status: this.statusOf(list.serving, e),
              blocked: list.serving
                ? (e.status?.blocked ?? []).map((b) => ({ task: b.task ?? "", error: b.error ?? "" }))
                : [],
            },
          ]
        : [],
    );
  }

  private statusOf(serving: boolean, e: Listed): RunEntryView["status"] {
    if (this.another) return { state: "not_served", message: NOT_SERVED.another };
    if (!serving) {
      if (this.child || this.beginning) return { state: "starting" };
      return { state: "not_served", message: this.next ? NOT_SERVED.restarting : NOT_SERVED.stopped };
    }
    const s = e.status ?? {};
    if (e.removing || s.state === "removing") return { state: "removing" };
    switch (s.state) {
      case undefined:
      case "starting":
        return { state: "starting" };
      case "ready":
      case "aside":
        return { state: s.state };
      case "working":
        return { state: "working", task: s.task ?? "" };
      case "paused":
        return PAUSES.includes(s.pause ?? "")
          ? { state: "paused", pause: s.pause as RunPause, ...(s.until ? { until: s.until } : {}) }
          : { state: "error", message: `paused: ${s.pause ?? ""}` };
      case "error":
        return { state: "error", message: s.message ?? "" };
      default:
        return { state: "error", message: s.state };
    }
  }

  /** `quadit run add …`, which checks everything and writes the entry; then the runner is started if it was not running. */
  async add(a: {
    login: string;
    project: string;
    folder: string;
    program: RunProgram;
    programPath?: string;
  }): Promise<{ ok: true } | Refused> {
    if (!this.available) return NO_QUADIT;
    const args = [
      "run",
      "add",
      `login=${a.login}`,
      `project=${a.project}`,
      `folder=${a.folder}`,
      `program=${a.program}`,
      ...(a.programPath ? [`program_path=${a.programPath}`] : []),
    ];
    const said = await this.run(args, ADD_MS, { PATH: await this.parts.path() });
    if (said.code !== 0) return { ok: false, error: said.words };
    this.parts.log(said.out.trim());
    await this.begin();
    this.parts.changed();
    return { ok: true };
  }

  /**
   * `quadit run remove …`, which stops the entry's run, tells the server how
   * it ended and lets the project go, waiting for that; then the runner is
   * stopped when no entry is left. With no quadit of the app's, the app
   * added none: nothing to remove.
   */
  async remove(by: { entry: string } | { login: string }): Promise<{ ok: true } | Refused> {
    if (!this.available) return { ok: true };
    const said = await this.run(["run", "remove", "entry" in by ? by.entry : `login=${by.login}`], REMOVE_MS);
    if (said.code !== 0) return { ok: false, error: said.words };
    this.parts.log(said.out.trim());
    const left = await this.list().catch(() => null);
    if (left?.entries.length === 0) this.stop();
    this.parts.changed();
    return { ok: true };
  }

  /** The projects the agent of the login `login` may work in: `quadit me`, as that login. */
  async projects(login: string): Promise<{ ok: true; projects: { key: string; name: string }[] } | Refused> {
    if (!this.available) return NO_QUADIT;
    const said = await this.run(["--json", "me"], COMMAND_MS, { QUADIT_CONFIG: login });
    if (said.code !== 0) return { ok: false, error: said.words };
    const me = JSON.parse(said.out) as { projects?: unknown; project_names?: unknown };
    const names = (typeof me.project_names === "object" && me.project_names) || {};
    const keys = Array.isArray(me.projects) ? me.projects.filter((key) => typeof key === "string") : [];
    return {
      ok: true,
      projects: keys.map((key: string) => {
        const name = (names as Record<string, unknown>)[key];
        return { key, name: typeof name === "string" ? name : key };
      }),
    };
  }

  /** The runner's own log (runner/runner.log, in the folder of the quadit logins); null without a quadit. */
  async logFile(): Promise<string | null> {
    if (!this.available) return null;
    const said = await this.run(["login", "--path"], COMMAND_MS);
    return said.code === 0 ? join(dirname(said.out.trim()), "runner", "runner.log") : null;
  }

  /** At the app's start: starts the runner when the registry has an entry. */
  async sync() {
    if (this.quitting || !this.available) return;
    const list = await this.list().catch((err: Error) => {
      this.parts.log(`quadit run list: ${err.message}`);
      return null;
    });
    if (list && list.entries.length > 0) await this.begin();
  }

  /** At quit: the guard's stop (SIGTERM to its group, killed 5 s later), never waited for; nothing starts again. */
  quit() {
    this.quitting = true;
    this.stop();
  }

  /** Starts the runner unless it runs; a start waiting (after an end, or for another runner) is made now. */
  private async begin() {
    const quadit = this.parts.quadit();
    if (this.quitting || this.child || this.beginning || !quadit) return;
    clearTimeout(this.next);
    this.next = undefined;
    this.beginning = true;
    const path = await this.parts.path().finally(() => (this.beginning = false));
    if (this.quitting || this.child) return;
    this.another = false;
    this.parts.log("starting quadit run");
    const child = this.parts.start(quadit, ["run"], {
      cwd: this.parts.env.HOME || "/",
      env: { ...withoutQuadit(this.parts.env), PATH: path },
      line: (line) => this.parts.log(line),
    });
    this.child = child;
    this.since = Date.now();
    this.parts.changed();
    void child.exited.then((code) => this.ended(child, code));
  }

  /** The runner ended: stopped by the app, nothing more; else it is started again as the rules at the top say. */
  private ended(child: RunningChild, code: number | null) {
    if (this.child !== child) return;
    this.child = null;
    this.parts.changed();
    if (this.quitting) return;
    let wait: number;
    if (code === ANOTHER_SERVES) {
      this.another = true;
      wait = ANOTHER_WAIT_MS;
      this.parts.log("another quadit run serves this computer; trying again in 5 minutes");
    } else {
      if (Date.now() - this.since >= STEADY_MS) this.waits = 0;
      wait = Math.min(FIRST_WAIT_MS * 2 ** this.waits, LAST_WAIT_MS);
      this.waits++;
      this.parts.log(
        `quadit run ended (${code === null ? "a signal" : `exit ${code}`}); starting it again in ${Math.round(wait / 1000)} s`,
      );
    }
    // Started again only while the registry has an entry (sync).
    this.next = setTimeout(() => {
      this.next = undefined;
      void this.sync();
    }, wait);
  }

  /** Stops the runner and any start waiting. */
  private stop() {
    clearTimeout(this.next);
    this.next = undefined;
    const child = this.child;
    this.child = null;
    this.another = false;
    if (child) {
      this.parts.log("stopping quadit run");
      child.stop();
      this.parts.changed();
    }
  }

  /** Runs the quadit the app carries with `args`, the app's environment without QUADIT_ settings and with `env`. */
  private run(
    args: string[],
    timeout: number,
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; out: string; words: string }> {
    const quadit = this.parts.quadit();
    if (!quadit) return Promise.resolve({ code: null, out: "", words: NO_QUADIT.error });
    return new Promise((resolve) => {
      execFile(quadit, args, { env: { ...withoutQuadit(this.parts.env), ...env }, timeout }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        // What it said when it refused: its error, else what it printed, else how it ended.
        const words = stderr.trim() || stdout.trim() || err?.message || "";
        resolve({ code, out: stdout, words });
      });
    });
  }
}

/** Whether two paths name the same file, links resolved where they can be. */
function sameFile(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return a === b || real(a) === real(b);
}
