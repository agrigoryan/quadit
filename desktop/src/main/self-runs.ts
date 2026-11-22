// What the app does by itself for the tools Connect set up (desktop
// contract §11, third amendment): the person chose to connect two programs
// of their own computer, so the app makes them work together.
//
//   Only for the app's own server, and only while it runs as the app's
//   child: a tool is the app's own server's when the login it runs with is
//   (that server's address, and the app's mark on the login), whatever the
//   ledger says. A tool of any other server is never run by itself to give
//   its code back (its card keeps the line to paste), and answers by itself
//   only when the person asks: words a remote server chose never reach a
//   tool run without them.
//
//   Giving the code back: right after Connect (and at a start, for a
//   connection still waiting), the tool is run once with its one-prompt
//   command and "Connect to Quadit CODE", as its own login, in a folder of
//   the app's, for two minutes at most. Done is the server's word that the
//   code was used, never the run's exit; otherwise the card falls back to
//   the line to paste, with the reason.
//
//   Answering: for each tool of the app's own server (on by default; for
//   another server only when the person turns it on), one listener, `quadit listen --exec`, as the tool's login, whose command
//   runs the tool's one-prompt command for each inbox item; it says it is
//   "the Quadit app" to whoever asks who listens. It is started again when
//   it ends by itself, waiting longer each time; it steps aside, never
//   taking over, while a chat listens as the agent (`quadit listening`
//   says so), and comes back after; a run longer than ten minutes is
//   stopped; more than six runs in a minute pauses the tool (a loop guard);
//   Pause is remembered.
//
// One program at a time for a tool, of all the app starts for it; each is
// started through child-guard.ts (a run's start and end come on the guard's
// lifecycle channel, never out of the tool's output) and stopped on Pause,
// Disconnect and quit; after every wait the app looks again whether it is
// quitting and the tool still wanted. What each said goes to the tool's log.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { childEnv, type RunningChild } from "@/main/child-guard";
import type { SelfRun } from "@/shared/pages-api";

/** A tool Connect set up, as the app runs it. */
export interface SelfRunTool {
  id: string;
  name: string;
  /** Its program (tool-program.ts); null when it was not found. */
  program: string | null;
  /** Its one-prompt command's arguments for a prompt (harnesses.ts); null when it has none the app may run. */
  oneShot: ((prompt: string) => string[]) | null;
  /** Its quadit login file, which every run of it uses. */
  login: string;
  /** Whether that login is for the server the app runs on this computer: its address, and the app's mark on it. */
  here: boolean;
  /** For a tool here: whether that server runs now as the app's own child; runs of it exist only then. */
  serverRuns: boolean;
  /** Whether it answers by itself, as the person chose; undefined: not chosen, on here and off elsewhere. */
  answering: boolean | undefined;
}

export interface SelfRunsParts {
  /** The tools Connect set up, as they are now. */
  tools(): Promise<SelfRunTool[]>;
  /** The quadit command the listeners run (on the PATH, else the app's own); null: none. */
  quadit(): Promise<string | null>;
  /** The login shell's PATH, which every run gets. */
  loginPath(): Promise<string>;
  /** Starts a program, held to the app (child-guard.ts, startChild). */
  start(
    program: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      line: (line: string) => void;
      lifecycle?: (event: string) => void;
    },
  ): RunningChild;
  /** Whether the server says the tool's connect code was given back. */
  codeGivenBack(id: string): Promise<boolean>;
  /**
   * Who listens as the tool's agent now (`quadit listening`, as its login),
   * which takes no lease: whether something does, and what (the app's own
   * listener says BY_LABEL, a chat "a chat"); null when it cannot be said.
   */
  listening(tool: SelfRunTool): Promise<{ listening: boolean; by: string } | null>;
  /** Remembers whether a tool answers by itself (the ledger). */
  remember(id: string, answering: boolean): void;
  /** The folder of the runs' working folders and of the tools' logs. */
  dir: string;
  /** The app's environment, which a run gets without its QUADIT_ settings (childEnv). */
  env: NodeJS.ProcessEnv;
  /** What a card shows of a tool changed. */
  changed(): void;
}

/** What the app's listeners say they are, to whoever asks who listens as the agent (a chat refused, `quadit listening`). */
export const BY_LABEL = "the Quadit app";

/** The argument the wake command puts the item's prompt in place of, in a tool's one-prompt command. */
const ITEM = "{quadit-item}";

/**
 * The command `quadit listen` runs for each item (after `sh -c`, then
 * "quadit-wake" as $0, then the tool's program and its arguments): it puts
 * the item into the prompt in place of ITEM, without a shell ever reading
 * the item's words, and says when a run starts and ends on the lifecycle
 * channel (child-guard.ts), which it hands on to nothing the tool runs.
 */
const WAKE_SCRIPT = `said=\${QUADIT_APP_LIFECYCLE:-/dev/null}
unset QUADIT_APP_LIFECYCLE
p="Quadit woke you for this inbox item: $QUADIT_EVENT. Handle it with the quadit skill, answering where you were asked."
for a do shift; if [ "$a" = "${ITEM}" ]; then set -- "$@" "$p"; else set -- "$@" "$a"; fi; done
echo started >> "$said"
"$@"
status=$?
echo "ended $status" >> "$said"
exit "$status"`;

const PROVE_LIMIT_MS = 2 * 60_000;
const RUN_LIMIT_MS = 10 * 60_000;
/** The loop guard: more runs than this in GUARD_WINDOW_MS pause the tool. */
const GUARD_RUNS = 6;
const GUARD_WINDOW_MS = 60_000;
/** The waits before starting a listener again after it ended by itself: from the first, doubling, to the last. */
const FIRST_WAIT_MS = 2_000;
const LAST_WAIT_MS = 5 * 60_000;
/** A listener that ran this long before it ended gets its waits back from the first. */
const STEADY_MS = 60_000;
/** How often a listener that stepped aside for a chat asks whether the chat stopped listening. */
const ASIDE_WAIT_MS = 60_000;
/** What a listener says when another session holds the agent's lease (a chat listening), or another listen this login. */
const ASIDE = /already listening from another session|listening_elsewhere|lease_stale|another quadit listen is running/;
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

/** What runs, or waits to, for one tool: one program at most, the run giving its code back or its listener. */
interface Held {
  proving: SelfRun["proving"];
  prover?: RunningChild;
  listener?: { child: RunningChild; since: number; aside: boolean; stopping: boolean };
  /** A program stopped and not yet ended: nothing else starts for the tool until it has. */
  ending?: Promise<unknown>;
  runTimer?: ReturnType<typeof setTimeout>;
  restart?: ReturnType<typeof setTimeout>;
  waits: number;
  runs: number[];
  guarded: boolean;
}

export class SelfRuns {
  private held = new Map<string, Held>();
  private quitting = false;
  /**
   * The tools and the quadit command as last looked at (sync, prove): a
   * card asks every couple of seconds, and looking runs the login shell.
   */
  private known: SelfRunTool[] = [];
  private quaditPath: string | null = null;
  /** The person's choices made here, before the ledger is read again. */
  private choices = new Map<string, boolean>();

  constructor(private parts: SelfRunsParts) {}

  /** The folder a tool's runs work in, which the app makes. */
  private runDir(id: string): string {
    const dir = join(this.parts.dir, "runs", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The log of what a tool's runs said. */
  logOf(id: string): string {
    return join(this.parts.dir, "logs", `${id}.log`);
  }

  private log(id: string, line: string) {
    const file = this.logOf(id);
    mkdirSync(join(this.parts.dir, "logs"), { recursive: true });
    // A log past its size starts anew, the one before kept beside it.
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_LIMIT_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  }

  private heldOf(id: string): Held {
    let held = this.held.get(id);
    if (!held) {
      held = { proving: null, waits: 0, runs: [], guarded: false };
      this.held.set(id, held);
    }
    return held;
  }

  /** Whether the app may run `tool` at all now: the app's own server's while it runs as the app's. */
  private mayRun(tool: SelfRunTool): boolean {
    return !this.quitting && tool.here && tool.serverRuns;
  }

  /**
   * Runs the tool once to give `code` back, as its own login; resolves when
   * that run is over. Done is the server's word; else the reason it could
   * not is kept for its card. A tool of another server, or without a
   * one-prompt command, is left to the line to paste.
   */
  async prove(id: string, code: string): Promise<void> {
    if (this.quitting) return;
    // Said at once, so its card never shows the line to paste before it shows this.
    const held = this.heldOf(id);
    held.proving = { state: "running" };
    this.known = await this.parts.tools();
    const path = await this.parts.loginPath();
    let tool = this.known.find((t) => t.id === id);
    if (!tool?.oneShot || !this.mayRun(tool)) {
      held.proving = null;
      this.parts.changed();
      return;
    }
    if (!tool.program) {
      held.proving = { state: "failed", reason: "it was not found on this computer" };
      this.parts.changed();
      return;
    }
    // One program at a time: the listener steps back meanwhile, and comes after.
    held.prover?.stop();
    await this.stopListener(held);
    await held.ending;
    tool = this.known.find((t) => t.id === id);
    if (!tool?.program || !tool.oneShot || !this.mayRun(tool)) {
      held.proving = null;
      this.parts.changed();
      return;
    }
    this.parts.changed();
    this.log(id, `giving the connect code back: ${tool.program}`);
    const child = this.parts.start(tool.program, tool.oneShot(`Connect to Quadit ${code}`), {
      cwd: this.runDir(id),
      env: childEnv(this.parts.env, tool.login, path),
      line: (line) => this.log(id, line),
    });
    held.prover = child;
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      child.stop();
    }, PROVE_LIMIT_MS);
    const exit = await child.exited;
    clearTimeout(timer);
    if (held.prover !== child) return;
    held.prover = undefined;
    if (this.quitting) return;
    if (await this.parts.codeGivenBack(id)) held.proving = null;
    else
      held.proving = {
        state: "failed",
        reason: late
          ? "it took longer than two minutes"
          : exit === 0
            ? "it did not give the code back"
            : "it stopped with an error",
      };
    this.log(id, held.proving ? `could not give the code back: ${held.proving.reason}` : "the code was given back");
    this.parts.changed();
    await this.sync();
  }

  /** What the app does by itself for a tool now, for its card; null for a tool not set up. */
  self(id: string): SelfRun | null {
    const tool = this.known.find((t) => t.id === id);
    if (!tool) return null;
    const held = this.held.get(id);
    return { proving: held?.proving ?? null, answering: this.answering(tool, held) };
  }

  private answering(tool: SelfRunTool, held: Held | undefined): SelfRun["answering"] {
    if (!tool.oneShot || !tool.program || !this.quaditPath) return "none";
    if (tool.here && !tool.serverRuns) return "none";
    if (held?.guarded) return "guarded";
    if (this.wants(tool)) return "on";
    return tool.here ? "paused" : "off";
  }

  /** Whether the tool answers by itself: as the person chose, else on for the server here and off elsewhere. */
  private wants(tool: SelfRunTool): boolean {
    const chosen = this.choices.get(tool.id) ?? tool.answering;
    return tool.here ? tool.serverRuns && (chosen ?? true) : chosen === true;
  }

  /** The person's Pause, Resume or "Answer by itself": remembered, and the listener follows, once the old one ended. */
  async setAnswering(id: string, on: boolean) {
    this.parts.remember(id, on);
    this.choices.set(id, on);
    const held = this.heldOf(id);
    held.guarded = false;
    held.runs = [];
    held.waits = 0;
    if (!on) {
      void this.stopListener(held);
      this.parts.changed();
      return;
    }
    await held.ending;
    await this.sync();
    this.parts.changed();
  }

  /**
   * Starts the listeners that should run and stops what should not: a tool
   * disconnected, paused, turned off, whose login is no longer the app's
   * own server's, or whose server no longer runs as the app's.
   */
  async sync() {
    if (this.quitting) return;
    const tools = await this.parts.tools();
    const quadit = await this.parts.quadit();
    const path = await this.parts.loginPath();
    if (this.quitting) return;
    this.known = tools;
    this.quaditPath = quadit;
    for (const [id, held] of this.held) {
      if (!tools.some((t) => t.id === id)) {
        this.stopAll(held);
        this.held.delete(id);
        this.choices.delete(id);
      }
    }
    for (const tool of tools) {
      const held = this.heldOf(tool.id);
      if (held.prover && !this.mayRun(tool)) held.prover.stop();
      const wanted = !!quadit && !!tool.program && !!tool.oneShot && !held.guarded && this.wants(tool);
      if (!wanted) {
        void this.stopListener(held);
        clearTimeout(held.restart);
        held.restart = undefined;
      } else if (quadit && !held.listener && !held.restart && !held.prover && !held.ending)
        this.listen(tool, quadit, path, held);
    }
  }

  private listen(tool: SelfRunTool, quadit: string, path: string, held: Held) {
    if (!tool.program || !tool.oneShot || this.quitting) return;
    this.log(tool.id, "listening");
    const args = [
      "listen",
      `by=${BY_LABEL}`,
      "--exec",
      "/bin/sh",
      "-c",
      WAKE_SCRIPT,
      "quadit-wake",
      tool.program,
      ...tool.oneShot(ITEM),
    ];
    const listener = { child: undefined as unknown as RunningChild, since: Date.now(), aside: false, stopping: false };
    listener.child = this.parts.start(quadit, args, {
      cwd: this.runDir(tool.id),
      env: childEnv(this.parts.env, tool.login, path),
      line: (line) => {
        this.log(tool.id, line);
        if (ASIDE.test(line)) listener.aside = true;
      },
      lifecycle: (event) => this.lifecycle(tool, held, listener, event),
    });
    held.listener = listener;
    void listener.child.exited.then(() => this.ended(tool, held, listener));
  }

  /** What a listener's run said of itself (its start, its end): the start counted and timed, the end noted. */
  private lifecycle(tool: SelfRunTool, held: Held, listener: NonNullable<Held["listener"]>, event: string) {
    if (event === "started") {
      const now = Date.now();
      held.runs = [...held.runs.filter((at) => now - at < GUARD_WINDOW_MS), now];
      if (held.runs.length > GUARD_RUNS) {
        this.log(tool.id, `paused: it was started ${held.runs.length} times in a minute`);
        held.guarded = true;
        this.parts.remember(tool.id, false);
        this.choices.set(tool.id, false);
        void this.stopListener(held);
        this.parts.changed();
        return;
      }
      clearTimeout(held.runTimer);
      held.runTimer = setTimeout(() => {
        this.log(tool.id, "the run took longer than ten minutes: stopped");
        // Ended by the app's limit, it is started again as one that ended by itself.
        listener.child.stop();
      }, RUN_LIMIT_MS);
    } else if (event.startsWith("ended")) {
      clearTimeout(held.runTimer);
      held.runTimer = undefined;
    }
  }

  /** A listener ended: by the app's wish, nothing more; by itself, it is started again after a wait. */
  private ended(tool: SelfRunTool, held: Held, listener: NonNullable<Held["listener"]>) {
    if (held.listener === listener) held.listener = undefined;
    clearTimeout(held.runTimer);
    held.runTimer = undefined;
    if (listener.stopping || this.quitting || held.guarded) return;
    if (listener.aside) {
      this.log(tool.id, "a chat listens as this agent: stepping aside until it stops");
      this.stepAside(tool, held);
      return;
    }
    if (Date.now() - listener.since >= STEADY_MS) held.waits = 0;
    const wait = Math.min(FIRST_WAIT_MS * 2 ** held.waits, LAST_WAIT_MS);
    held.waits++;
    this.log(tool.id, `the listener ended; starting it again in ${Math.round(wait / 1000)} s`);
    held.restart = setTimeout(() => {
      held.restart = undefined;
      void this.sync();
    }, wait);
  }

  /**
   * Waits, asking each minute who listens as the agent, while something
   * other than the app does (a chat); then starts the listener again, never
   * taking the lease over. When the command cannot say, it starts again and
   * steps aside anew if refused.
   */
  private stepAside(tool: SelfRunTool, held: Held) {
    held.restart = setTimeout(() => {
      void this.parts.listening(tool).then((who) => {
        if (this.quitting || held.restart === undefined) return;
        if (who?.listening && who.by !== BY_LABEL) {
          this.stepAside(tool, held);
          return;
        }
        held.restart = undefined;
        void this.sync();
      });
    }, ASIDE_WAIT_MS);
  }

  /** Stops a tool's listener; resolves once it has ended, which nothing else for the tool starts before. */
  private stopListener(held: Held): Promise<unknown> {
    const listener = held.listener;
    if (!listener) return held.ending ?? Promise.resolve();
    listener.stopping = true;
    held.listener = undefined;
    listener.child.stop();
    const ending = listener.child.exited.then(() => {
      if (held.ending === ending) held.ending = undefined;
    });
    held.ending = ending;
    return ending;
  }

  private stopAll(held: Held) {
    void this.stopListener(held);
    held.prover?.stop();
    held.prover = undefined;
    clearTimeout(held.restart);
    clearTimeout(held.runTimer);
    held.restart = undefined;
  }

  /** The app quits: every program it started stops, and none starts again. */
  quit() {
    this.quitting = true;
    for (const held of this.held.values()) this.stopAll(held);
  }
}
