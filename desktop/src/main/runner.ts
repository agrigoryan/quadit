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
// never waited for: the runner ends its programs when the guard asks it to
// stop (SIGTERM; on Windows quadit guard's own way, which quadit run takes
// as it takes SIGTERM), within the guard's grace.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RunningChild, type StartChild, withoutQuadit, withPath } from "@/main/child-guard";
import { homely } from "@/main/connections";
import { isProjectKey } from "@/shared/bridge";
import type { Refused, RunEntryView, RunPause, RunProgram, RunWaiting } from "@/shared/pages-api";

export interface RunnerParts {
  /** The quadit the app carries (its version is the app's); null in a build without one. */
  quadit: () => string | null;
  /** The login shell's PATH. */
  path: () => Promise<string>;
  /** The app's environment; the runner gets it without QUADIT_ settings (withoutQuadit). */
  env: NodeJS.ProcessEnv;
  /** The person's home folder: where the runner works from, and what a folder is shown under (~). */
  home: string;
  /** Starts a program, held to the app (child-guard.ts). */
  start: StartChild;
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
  /** The project's id, as the registry binds it. */
  project_id?: string;
  /** The server (the login's address), the workspace and the agent the entry is bound to. */
  server?: string;
  workspace_id?: string;
  agent_id?: string;
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
  /** This computer's name, as the registry has it ("" before it is first written). */
  machine: string;
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
/** How often the registry is read again while an entry is still being removed (quadit run remove gave up waiting). */
const RECHECK_MS = 30_000;
/** How long the projects a page is told of (projectsOf) are kept before the list is read again. */
const KEEP_MS = 5_000;
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

/** A task's key, as the server makes them ("SVA-12"): only such keys are shown. */
const TASK_KEY = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,9}$/;

/** A removal not done: `pending`, the runner is still telling the server how a run ended, and lets the entry go once it has. */
export type RemoveRefused = Refused & { pending?: true };

export class Runner {
  private child: RunningChild | null = null;
  /** When the runner running now was started. */
  private since = 0;
  /** How many times in a row it ended by itself soon after its start. */
  private waits = 0;
  /** The next start: after it ended by itself, while another serves this computer, or after the list could not be read. */
  private next: ReturnType<typeof setTimeout> | undefined;
  /** How many times in a row the list could not be read at a start. */
  private unread = 0;
  /** The next look at the registry while an entry is still being removed. */
  private recheck: ReturnType<typeof setTimeout> | undefined;
  /** Its last end said another quadit run serves this computer. */
  private another = false;
  private beginning = false;
  private quitting = false;
  /** The list being read, shared by whoever asks meanwhile (every shown card asks every 2 s). */
  private listing: Promise<RunList> | null = null;
  /** What the last failed read of the list said, logged once. */
  private listFailed = "";
  /** The list projectsOf read last, and when: a page may ask often, and each read starts a quadit run. */
  private kept: { list: RunList; at: number } | null = null;
  /** How many times the app changed the registry: a read begun before a change is not kept after it. */
  private changes = 0;

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
    const raw = JSON.parse(said.out) as { machine?: { name?: unknown }; serving?: unknown; entries?: unknown };
    const entries = Array.isArray(raw.entries) ? (raw.entries as Partial<Listed>[]) : [];
    return {
      machine: typeof raw.machine?.name === "string" ? raw.machine.name : "",
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
   * This computer's name, and the ids of the projects Quadit runs the agent
   * `agent` of the workspace `workspace` on the server `server` (its address)
   * for, with the login `login` (matched by real path): an entry the same
   * login file had for another server, workspace or agent is not its. Nothing
   * when the list cannot be read.
   */
  async projectsOf(of: {
    login: string;
    server: string;
    workspace: string;
    agent: string;
  }): Promise<{ machine: string; projects: string[] }> {
    const list = this.available ? await this.recentList().catch(() => null) : null;
    if (!list) return { machine: "", projects: [] };
    const projects = list.entries.flatMap((e) =>
      sameFile(e.login, of.login) &&
      sameServer(e.server ?? "", of.server) &&
      e.workspace_id === of.workspace &&
      e.agent_id === of.agent &&
      e.project_id
        ? [e.project_id]
        : [],
    );
    return { machine: list.machine, projects };
  }

  /** The app changed the registry: what projectsOf kept is old. */
  private forgetKept() {
    this.kept = null;
    this.changes++;
  }

  /** The list as read in the last few seconds, read again past them or once the app itself changed the registry. */
  private async recentList(): Promise<RunList> {
    if (this.kept && Date.now() - this.kept.at < KEEP_MS) return this.kept.list;
    const before = this.changes;
    const list = await this.list();
    if (before === this.changes) this.kept = { list, at: Date.now() };
    return list;
  }

  /**
   * The entries of the agent `of.agent` of the workspace `of.workspace` on
   * the server at `of.server` (an agent of one workspace: the entries are
   * bound to all three), and what each does now, as its card says them;
   * never another workspace's, whatever login file it has. Null when the
   * list cannot be read.
   */
  async entries(of: RunsOf): Promise<RunEntryView[] | null> {
    let list: RunList;
    try {
      list = await this.list();
      this.listFailed = "";
    } catch (err) {
      const words = (err as Error).message;
      if (words !== this.listFailed) this.parts.log(`quadit run list: ${words}`);
      this.listFailed = words;
      return null;
    }
    const { home } = this.parts;
    return list.entries.flatMap((e) =>
      isOf(e, of) && (e.program === "claude" || e.program === "codex")
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
      // A runner that has not said yet what the entry does: its checks run.
      case undefined:
      case "":
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
    const said = await this.run(args, ADD_MS, { path: await this.parts.path() });
    if (said.code !== 0) return { ok: false, error: said.words };
    this.parts.log(said.out.trim());
    this.forgetKept();
    await this.begin();
    this.parts.changed();
    return { ok: true };
  }

  /**
   * `quadit run remove ID` for the entry `entry`, or for each entry of one
   * agent of one workspace (`of`, as the card shows them: entries), which
   * stops its run, tells the server how it ended and lets the project go,
   * waiting for that. Done only when a fresh read of the registry has none
   * of them: one still there and marked removing is `pending` (the runner
   * lets it go once the server has heard), any other keeps what quadit run
   * said. Then the runner is stopped if no entry is left. With no quadit of
   * the app's, the app added none: nothing to remove.
   */
  async remove(by: { entry: string } | { of: RunsOf }): Promise<{ ok: true } | RemoveRefused> {
    if (!this.available) return { ok: true };
    let ids: string[];
    try {
      ids = "entry" in by ? [by.entry] : (await this.readList()).entries.filter((e) => isOf(e, by.of)).map((e) => e.id);
    } catch (err) {
      return { ok: false, error: `Quadit could not read what it runs on this computer: ${(err as Error).message}` };
    }
    let words = "";
    for (const id of ids) {
      const said = await this.run(["run", "remove", id], REMOVE_MS);
      if (said.code === 0) this.parts.log(said.out.trim());
      else words ||= said.words;
    }
    this.forgetKept();
    const left = await this.reconcile();
    this.parts.changed();
    const still = left ? left.entries.filter((e) => ids.includes(e.id)) : [];
    if (left && still.length === 0) return { ok: true };
    if (still.length > 0 && still.every((e) => e.removing)) return { ok: false, error: words, pending: true };
    return { ok: false, error: words || "Quadit could not stop running it: try again." };
  }

  /**
   * After a removal, from a fresh read of the registry (never one begun
   * before it): the runner stops when no entry is left, and is started when
   * some are (remove holds the runner's lock while it works, so a start
   * meanwhile found it held, exit 3); while an entry is still being removed,
   * or the registry cannot be read, it looks again in 30 s. Gives what it read.
   */
  private async reconcile(): Promise<RunList | null> {
    clearTimeout(this.recheck);
    this.recheck = undefined;
    const left = await this.readList().catch(() => null);
    if (this.quitting) return left;
    if (left?.entries.length === 0) this.stop();
    else if (left) await this.begin();
    if (!left || left.entries.some((e) => e.removing))
      this.recheck = setTimeout(() => void this.reconcile().then(() => this.parts.changed()), RECHECK_MS);
    return left;
  }

  /**
   * What `quadit run add` for `project` would start at once (`quadit run
   * waiting`, which only reads): the tasks that wait on the agent of the
   * login `login` there. Null when it cannot be told: a refusal, a server
   * not reached, a quadit without that form, an answer not of its form.
   */
  async waiting(login: string, project: string): Promise<RunWaiting | null> {
    if (!this.available) return null;
    const said = await this.run(["run", "waiting", `login=${login}`, `project=${project}`, "--json"], COMMAND_MS);
    if (said.code !== 0) return null;
    try {
      const raw = JSON.parse(said.out) as { agent?: unknown; runs?: unknown; tasks?: unknown };
      const tasks = Array.isArray(raw.tasks) ? (raw.tasks as { key?: unknown; title?: unknown }[]) : null;
      if (typeof raw.agent !== "string" || !Number.isSafeInteger(raw.runs) || (raw.runs as number) < 0 || !tasks)
        return null;
      const kept = tasks
        .slice(0, 5)
        .flatMap((t) =>
          typeof t?.key === "string" && TASK_KEY.test(t.key) && typeof t.title === "string"
            ? [{ key: t.key, title: t.title }]
            : [],
        );
      return { agent: raw.agent, runs: raw.runs as number, tasks: kept };
    } catch {
      return null;
    }
  }

  /**
   * The projects the agent of the login `login` may work in: `quadit me`, as
   * that login in its workspace `workspace` (an id), which a tool with a login
   * in several needs named, wherever the command runs.
   */
  async projects(
    login: string,
    workspace: string,
  ): Promise<{ ok: true; projects: { key: string; name: string }[] } | Refused> {
    if (!this.available) return NO_QUADIT;
    const said = await this.run(["--json", "me"], COMMAND_MS, { login, workspace });
    if (said.code !== 0) return { ok: false, error: said.words };
    const me = JSON.parse(said.out) as { projects?: unknown; project_names?: unknown };
    const names = (typeof me.project_names === "object" && me.project_names) || {};
    // Shown and handed back to quadit run add: only what has a project key's form.
    const keys: string[] = Array.isArray(me.projects) ? me.projects.filter(isProjectKey) : [];
    return {
      ok: true,
      projects: keys.map((key) => {
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

  /**
   * At the app's start, and at each start again: starts the runner when the
   * registry has an entry. A list that cannot be read is read again after
   * 2 s, doubling, at most 5 minutes.
   */
  async sync() {
    if (this.quitting || !this.available) return;
    const list = await this.list().catch((err: Error) => {
      this.parts.log(`quadit run list: ${err.message}`);
      return null;
    });
    if (this.quitting) return;
    if (!list) {
      const wait = Math.min(FIRST_WAIT_MS * 2 ** this.unread, LAST_WAIT_MS);
      this.unread++;
      clearTimeout(this.next);
      this.next = setTimeout(() => {
        this.next = undefined;
        void this.sync();
      }, wait);
      return;
    }
    this.unread = 0;
    if (list.entries.length > 0) await this.begin();
  }

  /** At quit: the guard's stop (asked to stop, ended 5 s later), never waited for; nothing starts again. */
  quit() {
    this.quitting = true;
    clearTimeout(this.recheck);
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
      cwd: this.parts.home,
      env: withPath(withoutQuadit(this.parts.env), path),
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

  /**
   * Runs the quadit the app carries with `args`, the app's environment
   * without QUADIT_ settings, as the quadit login `login` in the workspace
   * `workspace` when given, and with `path` as its PATH when given.
   */
  private run(
    args: string[],
    timeout: number,
    given: { login?: string; workspace?: string; path?: string } = {},
  ): Promise<{ code: number | null; out: string; words: string }> {
    const quadit = this.parts.quadit();
    if (!quadit) return Promise.resolve({ code: null, out: "", words: NO_QUADIT.error });
    let env = withoutQuadit(this.parts.env);
    if (given.path !== undefined) env = withPath(env, given.path);
    if (given.login !== undefined) env = { ...env, QUADIT_CONFIG: given.login };
    if (given.workspace !== undefined) env = { ...env, QUADIT_WORKSPACE: given.workspace };
    return new Promise((resolve) => {
      execFile(quadit, args, { env, timeout, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        // What it said when it refused: its error, else what it printed, else how it ended.
        const words = stderr.trim() || stdout.trim() || err?.message || "";
        resolve({ code, out: stdout, words });
      });
    });
  }
}

/** One agent of one workspace of one server, as the registry binds its entries: the server's address and the ids. */
export interface RunsOf {
  server: string;
  workspace: string;
  agent: string;
}

/** Whether the entry `e` is bound to the agent `of`: its server, workspace and agent. */
function isOf(e: Listed, of: RunsOf): boolean {
  return sameServer(e.server ?? "", of.server) && e.workspace_id === of.workspace && e.agent_id === of.agent;
}

/** Whether two server addresses are the same server's: alike but for a trailing "/". */
function sameServer(a: string, b: string): boolean {
  return a !== "" && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
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
