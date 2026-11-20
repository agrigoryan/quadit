// The Quadit server the app runs on this computer ("Run Quadit on this
// computer"): the bundled quadit, built with the web app, started as a child
// of the app and stopped when the app quits, the way Docker Desktop runs its
// engine. No service is installed: the server runs while the app does.
//
//   - It listens on 127.0.0.1 only, at a port chosen once (4780 when free)
//     and never changed: the address is the server's identity for its
//     cookies, sign-ins and agents. A port taken later is an error, not a move.
//   - Its data is the folder `server` in the app's data folder, which the
//     app never deletes; a folder with a database is simply used again.
//   - Its output goes to server.log in that folder. The log is started anew
//     at a start when it has grown past a few megabytes, keeping the one
//     before it beside as server.log.1.
//   - The app holds its standard input, and it runs with
//     --stop-on-stdin-close: if the app dies without stopping it, the input
//     closes and the server shuts down, so it never outlives the app.
//   - It is running once /readyz answers 200. One that exits on its own is
//     started again a few times, a little later each time, then shown as
//     failed with the last lines of its log.

import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import type { Fetch } from "@/main/probe";
import type { Settings } from "@/main/settings";

export type LocalState =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "running" }
  /** `log` is the last lines of the server's log. */
  | { kind: "failed"; reason: string; log: string[] };

/** What the app needs of a started quadit serve (Node's ChildProcess has it). */
export interface ServerProcess {
  kill(signal: NodeJS.Signals): boolean;
  /** "exit" when it ended; "error" when it could not be run at all. */
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (err: Error) => void): this;
}

/** Starts a program (Node's child_process.spawn). */
export type Spawn = (
  binary: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", number, number] },
) => ServerProcess;

/** The time, and waiting for it to pass. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Which ports of 127.0.0.1 are free. */
export interface Ports {
  /** Whether nothing listens on `port` and the app could listen there. */
  free(port: number): Promise<boolean>;
  /** A port the system says is free now. */
  any(): Promise<number>;
}

export interface LocalServerParts {
  /** The bundled quadit, built with the web app; null where this build has none (Windows, a run from source). */
  binary: string | null;
  /** The server's data folder: its database, files and log. */
  dataDir: string;
  /** Where the chosen port is remembered. */
  settings: Pick<Settings, "get" | "change">;
  spawn: Spawn;
  clock: Clock;
  /** How readiness is asked (Electron's net.fetch). */
  fetch: Fetch;
  ports: Ports;
  /** The app's environment, which the server gets without the QUADIT_ settings of the person's own servers. */
  env: NodeJS.ProcessEnv;
}

/** Quadit's own port, taken when it is free at set-up. */
const PREFERRED_PORT = 4780;
const READY_POLL_MS = 250;
const READY_LIMIT_MS = 120_000;
/** The server takes up to 5 s to finish what it is doing when told to stop (internal/app, shutdownTimeout). */
const STOP_LIMIT_MS = 10_000;
/** The waits before each start again after the server exited on its own; then it is shown as failed. */
const RESTART_DELAYS_MS = [1_000, 3_000, 10_000];
/** A server that ran this long before it exited gets its starts again back. */
const STEADY_MS = 60_000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
const LOG_LINES = 20;

export class LocalServer {
  readonly available: boolean;
  readonly dataDir: string;
  readonly logFile: string;
  private current: LocalState = { kind: "stopped" };
  private listeners = new Set<() => void>();
  private settledWaiters: (() => void)[] = [];
  private child: ServerProcess | undefined;
  private exited: Promise<void> = Promise.resolve();
  /** Counts each start and stop: a step of an older one finds it changed and does nothing more. */
  private generation = 0;
  private restarts = 0;
  private runningSince: number | null = null;

  constructor(private parts: LocalServerParts) {
    this.available = parts.binary !== null;
    this.dataDir = parts.dataDir;
    this.logFile = join(parts.dataDir, "server.log");
  }

  state(): LocalState {
    return this.current;
  }

  /** The server's address, once it has been set up; null before. */
  origin(): string | null {
    const port = this.parts.settings.get().localPort;
    return port === null ? null : originOf(port);
  }

  /** Calls `listener` after every change of state; gives the function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once the server is no longer starting: running, stopped or failed. */
  settled(): Promise<void> {
    if (this.current.kind !== "starting") return Promise.resolve();
    return new Promise((done) => this.settledWaiters.push(done));
  }

  /**
   * Chooses the server's port the first time (4780 when free, otherwise
   * one the system has free) and starts it; gives its address. Throws
   * where the app has no server to run.
   */
  async setUp(): Promise<string> {
    if (!this.available) throw new Error("This build of the app has no Quadit server to run.");
    let port = this.parts.settings.get().localPort;
    if (port === null) {
      port = (await this.parts.ports.free(PREFERRED_PORT)) ? PREFERRED_PORT : await this.parts.ports.any();
      this.parts.settings.change({ localPort: port });
    }
    this.start();
    return originOf(port);
  }

  /** Starts the server, unless it is starting or running already. Its state says how it goes. */
  start() {
    if (this.current.kind === "starting" || this.current.kind === "running") return;
    this.restarts = 0;
    void this.launch(++this.generation);
  }

  /** Stops the server and waits for it: SIGTERM, then SIGKILL if it has not exited in time. Never starts it again. */
  async stop(): Promise<void> {
    this.generation++;
    const child = this.child;
    if (child) {
      const exited = this.exited;
      child.kill("SIGTERM");
      const inTime = await Promise.race([
        exited.then(() => true),
        this.parts.clock.sleep(STOP_LIMIT_MS).then(() => false),
      ]);
      if (!inTime) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    this.set({ kind: "stopped" });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  /** One start of the server, as the start numbered `generation`. */
  private async launch(generation: number) {
    const { binary, settings, spawn, ports, clock, fetch } = this.parts;
    const port = settings.get().localPort;
    if (!binary || port === null) return;
    this.set({ kind: "starting" });
    if (!(await ports.free(port))) {
      if (generation === this.generation) {
        this.fail(
          `Port ${port} on this computer is in use by another program. The server here always uses it, ` +
            "because its address is part of your sign-in and your agents' settings: quit that program, then start the server again.",
          false,
        );
      }
      return;
    }
    if (generation !== this.generation) return;

    const log = this.openLog();
    const origin = originOf(port);
    const child = spawn(
      binary,
      ["serve", "--data", this.dataDir, "--listen", `127.0.0.1:${port}`, "--url", origin, "--stop-on-stdin-close"],
      { env: withoutQuaditSettings(this.parts.env), stdio: ["pipe", log, log] },
    );
    closeSync(log); // the server has its own copy
    this.child = child;
    let ended = false;
    let exitedNow = () => {};
    this.exited = new Promise((done) => (exitedNow = done));
    const end = (why: string, again: boolean) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = undefined;
      exitedNow();
      if (generation === this.generation) void this.exitedOnItsOwn(why, again);
    };
    child.once("exit", (code, signal) =>
      end(`The server stopped unexpectedly (${code !== null ? `exit code ${code}` : `signal ${signal}`}).`, true),
    );
    child.once("error", (err) => end(`The server could not be run: ${err.message}`, false));

    const started = clock.now();
    while (generation === this.generation && !ended) {
      const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(2_000) })
        .then((response) => response.status === 200)
        .catch(() => false);
      if (generation !== this.generation || ended) return;
      if (ready) {
        this.runningSince = clock.now();
        this.set({ kind: "running" });
        return;
      }
      if (clock.now() - started >= READY_LIMIT_MS) {
        this.generation++;
        child.kill("SIGTERM");
        this.fail("The server did not start within two minutes.", false);
        return;
      }
      await clock.sleep(READY_POLL_MS);
    }
  }

  /** The server ended without being asked: started again after a wait while it has starts left (`again`), failed otherwise. */
  private async exitedOnItsOwn(reason: string, again: boolean) {
    const { clock } = this.parts;
    if (this.runningSince !== null && clock.now() - this.runningSince >= STEADY_MS) this.restarts = 0;
    this.runningSince = null;
    const delay = again ? RESTART_DELAYS_MS[this.restarts] : undefined;
    if (delay === undefined) {
      this.fail(reason, true);
      return;
    }
    this.restarts++;
    this.set({ kind: "starting" });
    const generation = ++this.generation;
    await clock.sleep(delay);
    if (generation === this.generation) void this.launch(generation);
  }

  private fail(reason: string, withLog: boolean) {
    this.set({ kind: "failed", reason, log: withLog ? this.lastLogLines() : [] });
  }

  private set(state: LocalState) {
    if (JSON.stringify(state) === JSON.stringify(this.current)) return;
    this.current = state;
    for (const listener of this.listeners) listener();
    if (state.kind !== "starting") for (const done of this.settledWaiters.splice(0)) done();
  }

  /** Opens the log for the server to append to, starting a new one when it has grown large. */
  private openLog(): number {
    mkdirSync(this.dataDir, { recursive: true });
    const size = sizeOf(this.logFile);
    if (size !== null && size > LOG_LIMIT_BYTES) renameSync(this.logFile, `${this.logFile}.1`);
    const fd = openSync(this.logFile, "a", 0o600);
    writeSync(fd, `Started by the Quadit app at ${new Date().toISOString()}\n`);
    return fd;
  }

  private lastLogLines(): string[] {
    const size = sizeOf(this.logFile);
    if (!size) return [];
    const length = Math.min(size, 16 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(this.logFile, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-LOG_LINES);
  }
}

function originOf(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function sizeOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/** `env` without QUADIT_ variables: the person's own servers' settings (QUADIT_DB, QUADIT_SECRET…) are not this server's. */
function withoutQuaditSettings(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("QUADIT_")));
}

/** The ports of 127.0.0.1, as the system has them. */
export const loopbackPorts: Ports = {
  // Taken when something answers there (a server listening on all addresses
  // may still let the app bind 127.0.0.1, and would then be hidden by it),
  // or when the app could not listen there itself.
  async free(port) {
    const answers = await new Promise<boolean>((done) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => done(false));
    });
    if (answers) return false;
    return new Promise((done) => {
      const listener = createServer();
      listener.once("error", () => done(false));
      listener.listen(port, "127.0.0.1", () => listener.close(() => done(true)));
    });
  },
  any() {
    return new Promise((done, fail) => {
      const listener = createServer();
      listener.once("error", fail);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        listener.close(() =>
          typeof address === "object" && address ? done(address.port) : fail(new Error("no port")),
        );
      });
    });
  },
};
