// Giving a tool's connect code back by itself (desktop contract §11, third
// amendment): the person chose to connect two programs of their own
// computer, so the app proves the connection without a line to paste.
//
//   Only for the app's own server, and only while it runs as the app's
//   child: a tool is the app's own server's when the login it runs with is
//   (that server's address, and the app's mark on the login), whatever the
//   ledger says. A tool of any other server is never run: its card keeps the
//   line to paste.
//
//   Right after Connect (and for a connection the app has never run, with the
//   open code or a new one), the tool is run once with its one-prompt command
//   and "Connect to Quadit CODE in WORKSPACE", as its own login in that
//   workspace (QUADIT_WORKSPACE: a tool that works in several needs it to
//   give a code back), in a folder of the app's, for two minutes at most. Done is the server's word that the code was used,
//   never the run's exit, and the app marks it (ran); otherwise the card
//   falls back to the line to paste, with the reason.
//
// Each connection of a tool (one per workspace) is run for itself, by its key
// (connections.ts, connectionKey): one run at a time for each, started
// through child-guard.ts and stopped on its Disconnect and quit; after every wait the app looks again whether it is
// quitting and the connection still wanted. What each run said goes to the
// tool's log.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { childEnv, type RunningChild, type StartChild } from "@/main/child-guard";
import { appendLog } from "@/main/log-file";
import { connectLine } from "@/shared/connect-line";
import type { SelfRun } from "@/shared/pages-api";

/** A connection Connect made, as the app runs its tool. */
export interface SelfRunTool {
  /** The connection (connections.ts, connectionKey). */
  key: string;
  /** Its tool (a harness id): the runs of its connections share a folder and a log. */
  tool: string;
  name: string;
  /** Its program (tool-program.ts); null when it was not found. */
  program: string | null;
  /** Its one-prompt command's arguments for a prompt (harnesses.ts); null when it has none the app may run. */
  oneShot: ((prompt: string) => string[]) | null;
  /** Its quadit login file in that workspace. */
  login: string;
  /** What its run gives quadit (childEnv): the tool's base login, and the workspace it acts in. */
  quadit: { config: string; workspace: string | null };
  /** The workspace's name, which the line it is run with names. */
  workspace: string;
  /** Whether that login is for the server the app runs on this computer: its address, and the app's mark on it. */
  here: boolean;
  /** For a tool here: whether that server runs now as the app's own child; runs of it exist only then. */
  serverRuns: boolean;
  /** Whether the app ran it and saw it give its connect code back (the ledger's mark). */
  ran: boolean;
}

/** What the app looks at before it runs anything: the tools and the login shell's PATH. */
export interface SelfRunsLook {
  /** The connections Connect made, as they are now. */
  tools: SelfRunTool[];
  /** The login shell's PATH, which every run gets. */
  path: string;
}

export interface SelfRunsParts {
  look(): Promise<SelfRunsLook>;
  /** Starts a program, held to the app (child-guard.ts). */
  start: StartChild;
  /** Whether the server says the connection's connect code was given back (by its key). */
  codeGivenBack(key: string): Promise<boolean>;
  /** The connection's connect code still open, if any. */
  openCode(key: string): string | null;
  /** Makes the connection a new connect code; the app is told of it as of a Connect (prove follows). */
  newCode(key: string): Promise<void>;
  /** Marks the connection as run by the app and proven connected (the ledger). */
  ran(key: string): void;
  /** The folder of the runs' working folders and of the tools' logs. */
  dir: string;
  /** The app's environment, which a run gets without its QUADIT_ settings (childEnv). */
  env: NodeJS.ProcessEnv;
  /** What a card shows of a tool changed. */
  changed(): void;
}

const PROVE_LIMIT_MS = 2 * 60_000;

/** What runs, or is said, for one connection: its run giving the code back. */
interface Held {
  proving: SelfRun["proving"];
  prover?: RunningChild;
  /** The app gave its code back once this session (or tried): never again by itself. */
  tried: boolean;
}

export class SelfRuns {
  private held = new Map<string, Held>();
  private quitting = false;
  /** The tools as last looked at (sync, prove): a card asks every couple of seconds, and looking runs the login shell. */
  private known: SelfRunTool[] = [];

  constructor(private parts: SelfRunsParts) {}

  /** The folder a tool's runs work in, which the app makes. */
  private runDir(tool: string): string {
    const dir = join(this.parts.dir, "runs", tool);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The log of what a tool's runs said, of all its connections. */
  logOf(tool: string): string {
    return join(this.parts.dir, "logs", `${tool}.log`);
  }

  private log(tool: string, line: string) {
    appendLog(this.logOf(tool), line);
  }

  private heldOf(key: string): Held {
    let held = this.held.get(key);
    if (!held) {
      held = { proving: null, tried: false };
      this.held.set(key, held);
    }
    return held;
  }

  /** Whether the app may run `tool` at all now: the app's own server's while it runs as the app's. */
  private mayRun(tool: SelfRunTool): boolean {
    return !this.quitting && tool.here && tool.serverRuns && !!tool.oneShot;
  }

  /**
   * Runs the connection's tool once to give `code` back, as its own login
   * there; resolves when that run is over. Done is the server's word, and
   * marked; else the reason it could not is kept for its card. A tool of
   * another server, or without a one-prompt command, is left to the line to
   * paste.
   */
  async prove(key: string, code: string): Promise<void> {
    if (this.quitting) return;
    // Said at once, so its card never shows the line to paste before it shows this.
    const held = this.heldOf(key);
    held.proving = { state: "running" };
    held.tried = true;
    this.parts.changed();
    const { tools, path } = await this.parts.look();
    // Taken back meanwhile (disconnected): nothing starts for it.
    if (this.held.get(key) !== held) return;
    this.known = tools;
    const tool = this.known.find((t) => t.key === key);
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
    // One run at a time: one asked before for another code goes.
    held.prover?.stop();
    this.log(tool.tool, `giving the connect code back in ${tool.workspace}: ${tool.program}`);
    const child = this.parts.start(tool.program, tool.oneShot(connectLine(code, tool.workspace)), {
      cwd: this.runDir(tool.tool),
      env: childEnv(this.parts.env, tool.quadit, path),
      line: (line) => this.log(tool.tool, line),
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
    if (await this.parts.codeGivenBack(key)) {
      held.proving = null;
      this.parts.ran(key);
    } else held.proving = { state: "failed", reason: late ? "it took longer than two minutes" : failedHow(exit) };
    this.log(
      tool.tool,
      held.proving ? `could not give the code back: ${held.proving.reason}` : "the code was given back",
    );
    this.parts.changed();
  }

  /** What the app does by itself for a connection now, for its card; null for one not made. */
  self(key: string): SelfRun | null {
    const held = this.held.get(key);
    // Giving its code back is said before the tools were looked at.
    if (!this.known.some((t) => t.key === key)) return held?.proving ? { proving: held.proving } : null;
    return { proving: held?.proving ?? null };
  }

  /** A connection taken back (Undo, Disconnect): its run stops now, and none starts for it from a look begun before. */
  disconnected(key: string) {
    this.held.get(key)?.prover?.stop();
    this.held.delete(key);
    this.parts.changed();
    void this.sync();
  }

  /**
   * Looks at the tools again: a tool the app never ran gives its code back
   * (the open one, else a new one, asked once); a run of a tool disconnected,
   * whose login is no longer the app's own server's, or whose server no
   * longer runs as the app's, stops.
   */
  async sync() {
    if (this.quitting) return;
    const { tools } = await this.parts.look();
    if (this.quitting) return;
    this.known = tools;
    for (const [key, held] of this.held) {
      // A connection giving its code back stays: this look may have begun before it was made.
      if (!tools.some((t) => t.key === key) && !held.prover && held.proving?.state !== "running") this.held.delete(key);
    }
    for (const tool of tools) {
      const held = this.heldOf(tool.key);
      if (held.prover && !this.mayRun(tool)) held.prover.stop();
      if (this.mayRun(tool) && tool.program && !tool.ran && !held.tried) {
        held.tried = true;
        const code = this.parts.openCode(tool.key);
        // A new code comes back as a Connect does: prove follows.
        void (code ? this.prove(tool.key, code) : this.parts.newCode(tool.key));
      }
    }
    this.parts.changed();
  }

  /** The app quits: every run it started stops, and none starts again. */
  quit() {
    this.quitting = true;
    for (const held of this.held.values()) held.prover?.stop();
  }
}

/**
 * Why a run that ended in time did not give the code back, from its exit:
 * the guard's own codes (child-guard.ts), as a shell's, say the program was
 * not found (127) or could not be started (126: on Windows the guard
 * refuses a path or an argument it cannot pass safely).
 */
function failedHow(exit: number | null): string {
  switch (exit) {
    case 0:
      return "it did not give the code back";
    case 127:
      return "it was not found on this computer";
    case 126:
      return "it cannot be started from where it is installed";
    default:
      return "it stopped with an error";
  }
}
