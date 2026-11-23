// What the app does by itself for the tools Connect set up (desktop
// contract §11, third amendment): the person chose to connect two programs
// of their own computer, so the app makes them work together.
//
//   Only for the app's own server, and only while it runs as the app's
//   child: a tool is the app's own server's when the login it runs with is
//   (that server's address, and the app's mark on the login), whatever the
//   ledger says. A tool of any other server is never run by itself: its
//   card keeps the line to paste and offers no answering.
//
//   Giving the code back: right after Connect (and for a tool the app has
//   never run, with the open code or a new one), the tool is run once with
//   its one-prompt command and "Connect to Quadit CODE", as its own login,
//   in a folder of the app's, for two minutes at most. Done is the server's
//   word that the code was used, never the run's exit, and the app marks it
//   (ran); otherwise the card falls back to the line to paste, with the
//   reason.
//
//   Answering (off in the app for now: SelfRunsParts.answers): only for a
//   tool the app ran and saw give its code back, one listener for each login
//   (on by default),
//   `quadit listen by=the Quadit app limit=600 tries=3 events=FILE --exec`,
//   whose command runs the tool's one-prompt command for each inbox item.
//   quadit listen bounds each run and gives an item up after three failed
//   runs; its report (the events file, which the tool's output never
//   reaches) is all the app goes by: the loop guard (more than six runs in
//   a minute pauses the tool) and an item given up (said on the card until
//   the next is answered). A listener that ends by itself is started again,
//   waiting longer each time; refused because a chat listens as the agent,
//   never longer than a minute, so it is back soon after the chat's lease
//   dies (90 s after the chat stops). Pause is remembered.
//
// One program at a time for a tool, of all the app starts for it; each is
// started through child-guard.ts and stopped on Pause, Disconnect and quit;
// after every wait the app looks again whether it is quitting and the tool
// still wanted. What each said goes to the tool's log.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { childEnv, EVENTS_FILE, type RunningChild } from "@/main/child-guard";
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
  /** Whether the app ran it and saw it give its connect code back (the ledger's mark); only then does it listen. */
  ran: boolean;
  /** Whether it answers by itself: off only when the person paused it. */
  answering: boolean;
}

/** What the app looks at before it runs anything: the tools, the quadit command and the login shell's PATH. */
export interface SelfRunsLook {
  /** The tools Connect set up, as they are now. */
  tools: SelfRunTool[];
  /** The quadit command the listeners run (on the PATH, else the app's own); null: none. */
  quadit: string | null;
  /** The login shell's PATH, which every run gets. */
  path: string;
}

export interface SelfRunsParts {
  /**
   * Whether the app answers for its tools at all: false, and no listener
   * ever starts, `self` says "none", and the card says nothing of answering;
   * giving the code back is the same either way.
   */
  answers: boolean;
  look(): Promise<SelfRunsLook>;
  /** Starts a program, held to the app (child-guard.ts, startChild). */
  start(
    program: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      line: (line: string) => void;
      events?: (line: string) => void;
    },
  ): RunningChild;
  /** Whether the server says the tool's connect code was given back. */
  codeGivenBack(id: string): Promise<boolean>;
  /** The tool's connect code still open, if any. */
  openCode(id: string): string | null;
  /** Makes the tool a new connect code; the app is told of it as of a Connect (prove follows). */
  newCode(id: string): Promise<void>;
  /** Marks the tool as run by the app and proven connected (the ledger). */
  ran(id: string): void;
  /** Remembers whether a tool answers by itself (the ledger). */
  remember(id: string, answering: boolean): void;
  /** The folder of the runs' working folders and of the tools' logs. */
  dir: string;
  /** The app's environment, which a run gets without its QUADIT_ settings (childEnv). */
  env: NodeJS.ProcessEnv;
  /** What a card shows of a tool changed. */
  changed(): void;
}

/** What the app's listeners say they are, to whoever asks who listens as the agent (a chat refused). */
const BY_LABEL = "the Quadit app";

/** The argument the wake command puts the item's prompt in place of, in a tool's one-prompt command. */
const ITEM = "{quadit-item}";

/**
 * The command `quadit listen` runs for each item (after `sh -c`, then
 * "quadit-wake" as $0, then the tool's program and its arguments): it puts
 * the prompt for the item (QUADIT_ITEM, what `quadit wait` prints of it) in
 * place of ITEM, as one argument, without a shell ever reading its words.
 */
export const WAKE_SCRIPT = `p="Quadit woke you for this inbox item:
$QUADIT_ITEM
Handle it with the quadit skill: answer where you were asked, and write nothing when it asks nothing of you."
for a do shift; if [ "$a" = "${ITEM}" ]; then set -- "$@" "$p"; else set -- "$@" "$a"; fi; done
exec "$@"`;

const PROVE_LIMIT_MS = 2 * 60_000;
/** What quadit listen holds a run to, and how many failed runs of an item it tries before giving the item up. */
const RUN_LIMIT_S = 600;
const TRIES = 3;
/** The loop guard: more runs than this in GUARD_WINDOW_MS pause the tool. */
const GUARD_RUNS = 6;
const GUARD_WINDOW_MS = 60_000;
/** The waits before starting a listener again after it ended by itself: from the first, doubling, to the last. */
const FIRST_WAIT_MS = 2_000;
const LAST_WAIT_MS = 5 * 60_000;
/** A listener that ran this long before it ended gets its waits back from the first. */
const STEADY_MS = 60_000;
/** The longest wait after a listener was refused because another listens as the agent (a chat). */
const ASIDE_LAST_WAIT_MS = 60_000;
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

interface Listener {
  child: RunningChild;
  since: number;
  /** Refused because another listens as the agent (a chat). */
  aside: boolean;
  stopping: boolean;
}

/** What runs, or waits to, for one tool: one program at most, the run giving its code back or its listener. */
interface Held {
  proving: SelfRun["proving"];
  prover?: RunningChild;
  /** The app gave its code back once this session (or tried): never again by itself. */
  tried: boolean;
  /** It did, in a run of the app's this session (the ledger is read again later). */
  proven?: true;
  listener?: Listener;
  /** A program stopped and not yet ended: nothing else starts for the tool until it has. */
  ending?: Promise<unknown>;
  restart?: ReturnType<typeof setTimeout>;
  waits: number;
  runs: number[];
  guarded: boolean;
  /** Why the last run failed, and why the last item given up was, until one is answered. */
  failed?: string;
  missed?: string;
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
  /** For each login, the tool that listens with it (one lease each). */
  private holders = new Map<string, string>();

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
    // What the tool was asked and said is the person's: theirs alone to read.
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  }

  private heldOf(id: string): Held {
    let held = this.held.get(id);
    if (!held) {
      held = { proving: null, tried: false, waits: 0, runs: [], guarded: false };
      this.held.set(id, held);
    }
    return held;
  }

  /** Whether the app may run `tool` at all now: the app's own server's while it runs as the app's. */
  private mayRun(tool: SelfRunTool): boolean {
    return !this.quitting && tool.here && tool.serverRuns && !!tool.oneShot;
  }

  /**
   * Runs the tool once to give `code` back, as its own login; resolves when
   * that run is over. Done is the server's word, and marked; else the
   * reason it could not is kept for its card. A tool of another server, or
   * without a one-prompt command, is left to the line to paste.
   */
  async prove(id: string, code: string): Promise<void> {
    if (this.quitting) return;
    // Said at once, so its card never shows the line to paste before it shows this.
    const held = this.heldOf(id);
    held.proving = { state: "running" };
    held.tried = true;
    this.parts.changed();
    const { tools, path } = await this.parts.look();
    // Taken back meanwhile (disconnected): nothing starts for it.
    if (this.held.get(id) !== held) return;
    this.known = tools;
    let tool = this.known.find((t) => t.id === id);
    if (!tool || !this.mayRun(tool)) {
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
    if (this.held.get(id) !== held) return;
    tool = this.known.find((t) => t.id === id);
    if (!tool?.program || !tool.oneShot || !this.mayRun(tool)) {
      held.proving = null;
      this.parts.changed();
      return;
    }
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
    if (await this.parts.codeGivenBack(id)) {
      held.proving = null;
      held.proven = true;
      this.parts.ran(id);
    } else
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
    const held = this.held.get(id);
    const tool = this.known.find((t) => t.id === id);
    // Giving its code back, said before the tools were looked at.
    if (!tool) return held?.proving ? { proving: held.proving, answering: "none" } : null;
    const answering = this.answering(tool, held);
    return {
      proving: held?.proving ?? null,
      answering,
      ...(answering === "on" && held?.missed ? { missed: held.missed } : {}),
    };
  }

  private answering(tool: SelfRunTool, held: Held | undefined): SelfRun["answering"] {
    if (!this.mayAnswer(tool) || this.holders.get(tool.login) !== tool.id) return "none";
    if (held?.guarded) return "guarded";
    return tool.answering ? "on" : "paused";
  }

  /** Whether the tool may answer by itself at all: the app answers, runs it, found it, and saw it give its code back. */
  private mayAnswer(tool: SelfRunTool): boolean {
    return (
      this.parts.answers &&
      this.mayRun(tool) &&
      !!tool.program &&
      !!this.quaditPath &&
      (tool.ran || !!this.held.get(tool.id)?.proven)
    );
  }

  /** Remembers whether a tool answers by itself, in the ledger and in the tools as last looked at. */
  private remember(id: string, on: boolean) {
    this.parts.remember(id, on);
    const tool = this.known.find((t) => t.id === id);
    if (tool) tool.answering = on;
  }

  /** The person's Pause or Resume: remembered, and the listener follows, once the old one ended. */
  async setAnswering(id: string, on: boolean) {
    this.remember(id, on);
    const held = this.heldOf(id);
    held.guarded = false;
    held.missed = undefined;
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

  /** A tool taken back (Undo, Disconnect): what runs for it stops now, and nothing starts for it from a look begun before. */
  disconnected(id: string) {
    const held = this.held.get(id);
    if (held) this.stopAll(held);
    this.held.delete(id);
    this.parts.changed();
    void this.sync();
  }

  /**
   * Starts the listeners that should run and stops what should not: a tool
   * disconnected, paused, whose login is no longer the app's own server's,
   * or whose server no longer runs as the app's. A tool the app never ran
   * gives its code back first.
   */
  async sync() {
    if (this.quitting) return;
    const { tools, quadit, path } = await this.parts.look();
    if (this.quitting) return;
    this.known = tools;
    this.quaditPath = quadit;
    for (const [id, held] of this.held) {
      // A tool giving its code back stays: this look may have begun before it was connected.
      if (!tools.some((t) => t.id === id) && !held.prover && held.proving?.state !== "running") {
        this.stopAll(held);
        this.held.delete(id);
      }
    }
    this.holders = this.holdersOf(tools);
    for (const tool of tools) {
      const held = this.heldOf(tool.id);
      if (held.prover && !this.mayRun(tool)) held.prover.stop();
      if (this.mayRun(tool) && tool.program && !tool.ran && !held.tried) {
        held.tried = true;
        const code = this.parts.openCode(tool.id);
        // A new code comes back as a Connect does: prove follows.
        void (code ? this.prove(tool.id, code) : this.parts.newCode(tool.id));
        continue;
      }
      const wanted = this.answering(tool, held) === "on";
      if (!wanted) {
        void this.stopListener(held);
        clearTimeout(held.restart);
        held.restart = undefined;
      } else if (quadit && !held.listener && !held.restart && !held.prover && !held.ending)
        this.listen(tool, quadit, path, held);
    }
    this.parts.changed();
  }

  /** For each login, the tool that listens with it: the one listening already, else the first that may. */
  private holdersOf(tools: SelfRunTool[]): Map<string, string> {
    const holders = new Map<string, string>();
    const may = tools.filter((t) => this.mayAnswer(t));
    for (const tool of may) if (this.held.get(tool.id)?.listener) holders.set(tool.login, tool.id);
    for (const tool of may) if (!holders.has(tool.login)) holders.set(tool.login, tool.id);
    return holders;
  }

  private listen(tool: SelfRunTool, quadit: string, path: string, held: Held) {
    if (!tool.program || !tool.oneShot || this.quitting) return;
    this.log(tool.id, "listening");
    const args = [
      "listen",
      `by=${BY_LABEL}`,
      `limit=${RUN_LIMIT_S}`,
      `tries=${TRIES}`,
      `events=${EVENTS_FILE}`,
      "--exec",
      "/bin/sh",
      "-c",
      WAKE_SCRIPT,
      "quadit-wake",
      tool.program,
      ...tool.oneShot(ITEM),
    ];
    const listener: Listener = {
      child: undefined as unknown as RunningChild,
      since: Date.now(),
      aside: false,
      stopping: false,
    };
    listener.child = this.parts.start(quadit, args, {
      cwd: this.runDir(tool.id),
      env: childEnv(this.parts.env, tool.login, path),
      line: (line) => this.log(tool.id, line),
      events: (line) => this.reported(tool, held, listener, line),
    });
    held.listener = listener;
    void listener.child.exited.then(() => this.ended(tool, held, listener));
  }

  /** A line of a listener's report (`quadit listen events=`); a line it does not know is passed over. */
  private reported(tool: SelfRunTool, held: Held, listener: Listener, line: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null) return;
    switch (event.event) {
      case "run_started": {
        const now = Date.now();
        held.runs = [...held.runs.filter((at) => now - at < GUARD_WINDOW_MS), now];
        if (held.runs.length > GUARD_RUNS) {
          this.log(tool.id, `paused: it was started more than ${GUARD_RUNS} times in a minute`);
          held.guarded = true;
          this.pause(tool, held);
        }
        return;
      }
      case "run_ended": {
        const { status } = event;
        if (status === 0) {
          held.failed = undefined;
          held.missed = undefined;
          this.parts.changed();
        } else held.failed = status === "limit" ? "it took too long" : `${tool.name} stopped with an error`;
        return;
      }
      case "gave_up": {
        held.missed = held.failed ?? "it could not run it";
        this.log(tool.id, `could not answer one item: ${held.missed}`);
        this.parts.changed();
        return;
      }
      case "refused":
        listener.aside = true;
        return;
      default:
    }
  }

  /** Pauses the tool by itself (the loop guard): remembered, as the person's Pause is. */
  private pause(tool: SelfRunTool, held: Held) {
    this.remember(tool.id, false);
    void this.stopListener(held);
    this.parts.changed();
  }

  /** A listener ended: by the app's wish, nothing more; by itself, it is started again after a wait. */
  private ended(tool: SelfRunTool, held: Held, listener: Listener) {
    if (held.listener === listener) held.listener = undefined;
    if (listener.stopping || this.quitting || held.guarded) return;
    if (Date.now() - listener.since >= STEADY_MS) held.waits = 0;
    // Refused for a chat: tried again within a minute, never taking the lease over.
    const last = listener.aside ? ASIDE_LAST_WAIT_MS : LAST_WAIT_MS;
    const wait = Math.min(FIRST_WAIT_MS * 2 ** held.waits, last);
    held.waits++;
    this.log(
      tool.id,
      `${listener.aside ? "another listens as this agent (a chat)" : "the listener ended"}; starting it again in ${Math.round(wait / 1000)} s`,
    );
    held.restart = setTimeout(() => {
      held.restart = undefined;
      void this.sync();
    }, wait);
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
    held.restart = undefined;
  }

  /** The app quits: every program it started stops, and none starts again. */
  quit() {
    this.quitting = true;
    for (const held of this.held.values()) this.stopAll(held);
  }
}
