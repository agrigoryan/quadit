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
//   Right after Connect (and for a tool the app has never run, with the open
//   code or a new one), the tool is run once with its one-prompt command and
//   "Connect to Quadit CODE", as its own login, in a folder of the app's, for
//   two minutes at most. Done is the server's word that the code was used,
//   never the run's exit, and the app marks it (ran); otherwise the card
//   falls back to the line to paste, with the reason.
//
// One run at a time for a tool, started through child-guard.ts and stopped
// on Disconnect and quit; after every wait the app looks again whether it is
// quitting and the tool still wanted. What each run said goes to the tool's
// log.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { childEnv, type RunningChild, type StartChild } from "@/main/child-guard";
import { appendLog } from "@/main/log-file";
import type { SelfRun } from "@/shared/pages-api";

/** A tool Connect set up, as the app runs it. */
export interface SelfRunTool {
  id: string;
  name: string;
  /** Its program (tool-program.ts); null when it was not found. */
  program: string | null;
  /** Its one-prompt command's arguments for a prompt (harnesses.ts); null when it has none the app may run. */
  oneShot: ((prompt: string) => string[]) | null;
  /** Its quadit login file, which its run uses. */
  login: string;
  /** Whether that login is for the server the app runs on this computer: its address, and the app's mark on it. */
  here: boolean;
  /** For a tool here: whether that server runs now as the app's own child; runs of it exist only then. */
  serverRuns: boolean;
  /** Whether the app ran it and saw it give its connect code back (the ledger's mark). */
  ran: boolean;
}

/** What the app looks at before it runs anything: the tools and the login shell's PATH. */
export interface SelfRunsLook {
  /** The tools Connect set up, as they are now. */
  tools: SelfRunTool[];
  /** The login shell's PATH, which every run gets. */
  path: string;
}

export interface SelfRunsParts {
  look(): Promise<SelfRunsLook>;
  /** Starts a program, held to the app (child-guard.ts). */
  start: StartChild;
  /** Whether the server says the tool's connect code was given back. */
  codeGivenBack(id: string): Promise<boolean>;
  /** The tool's connect code still open, if any. */
  openCode(id: string): string | null;
  /** Makes the tool a new connect code; the app is told of it as of a Connect (prove follows). */
  newCode(id: string): Promise<void>;
  /** Marks the tool as run by the app and proven connected (the ledger). */
  ran(id: string): void;
  /** The folder of the runs' working folders and of the tools' logs. */
  dir: string;
  /** The app's environment, which a run gets without its QUADIT_ settings (childEnv). */
  env: NodeJS.ProcessEnv;
  /** What a card shows of a tool changed. */
  changed(): void;
}

const PROVE_LIMIT_MS = 2 * 60_000;

/** What runs, or is said, for one tool: its run giving the code back. */
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
    appendLog(this.logOf(id), line);
  }

  private heldOf(id: string): Held {
    let held = this.held.get(id);
    if (!held) {
      held = { proving: null, tried: false };
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
    const tool = this.known.find((t) => t.id === id);
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
  }

  /** What the app does by itself for a tool now, for its card; null for a tool not set up. */
  self(id: string): SelfRun | null {
    const held = this.held.get(id);
    // Giving its code back is said before the tools were looked at.
    if (!this.known.some((t) => t.id === id)) return held?.proving ? { proving: held.proving } : null;
    return { proving: held?.proving ?? null };
  }

  /** A tool taken back (Undo, Disconnect): its run stops now, and none starts for it from a look begun before. */
  disconnected(id: string) {
    this.held.get(id)?.prover?.stop();
    this.held.delete(id);
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
    for (const [id, held] of this.held) {
      // A tool giving its code back stays: this look may have begun before it was connected.
      if (!tools.some((t) => t.id === id) && !held.prover && held.proving?.state !== "running") this.held.delete(id);
    }
    for (const tool of tools) {
      const held = this.heldOf(tool.id);
      if (held.prover && !this.mayRun(tool)) held.prover.stop();
      if (this.mayRun(tool) && tool.program && !tool.ran && !held.tried) {
        held.tried = true;
        const code = this.parts.openCode(tool.id);
        // A new code comes back as a Connect does: prove follows.
        void (code ? this.prove(tool.id, code) : this.parts.newCode(tool.id));
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
