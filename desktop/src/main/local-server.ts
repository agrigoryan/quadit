// The Quadit server the app runs on this computer ("Set up on this
// computer"): the bundled quadit, built with the web app, started as a child
// of the app and stopped when the app quits, the way Docker Desktop runs its
// engine. No service is installed: the server runs while the app does.
// Quitting never waits for it (a logout would be held up): the server is
// told to stop and finishes on its own.
//
//   - It listens on 127.0.0.1 only, at a port chosen once (4780 when free)
//     and never changed: the address is the server's identity for its
//     cookies, sign-ins and agents. A port taken later is an error, not a
//     move, once the server before has had a few seconds to let go of it.
//   - Its data is the folder `server` in the app's data folder, which the
//     app never deletes; a folder with a database is simply used again.
//   - It gets the login shell's PATH, as Connect does (quadit-cli.ts): an app
//     opened from the Dock has a short one, without git, ffmpeg or Chrome.
//   - Its output goes to server.log in that folder. The log is started anew
//     at a start when it has grown past a few megabytes, keeping the one
//     before it beside as server.log.1.
//   - The app holds its standard input, and it runs with
//     --stop-on-stdin-close: if the app dies without stopping it, the input
//     closes and the server shuts down, so it never outlives the app.
//   - Its first line of input is the app key (--app-key-stdin), made anew at
//     every start and kept only here, in memory: it is never logged, put in
//     settings or given to a page. A request carrying it is the app that runs
//     the server, which may make the install's owner and sign a window in as
//     them without a form (setUpOwner, signInOwner; desktop contract §7).
//   - It is reached directly, never through a proxy (--trusted-proxies=),
//     and has passkeys off: no passkey can be made for an address that is
//     a number, and the sign-in page would offer them.
//   - It is running once /healthz answers 200 (its listener opens only
//     after the database is open and upgraded, internal/app, Serve, while
//     /readyz also asks a cloud file store, which may be away while the
//     server is usable) and it has then proved that it holds this start's
//     key (contract §7, "The proof"): another program may answer on its
//     port, having taken it between the app's check and the server's
//     start. Until then nothing with the key or with cookies is sent there,
//     and a window loads its address only while it runs (whenRunning):
//     what else answers there must not get its sign-in. A start whose proof
//     fails is stopped and shown as failed.
//   - One that exits on its own is started again a few times, a little
//     later each time, then shown as failed with the last lines of its log.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import type { Fetch } from "@/main/probe";
import type { Settings } from "@/main/settings";
import type { LocalState } from "@/shared/pages-api";

/** What the app needs of a started quadit serve (Node's ChildProcess has it). */
export interface ServerProcess {
  /** Its standard input; null only when it was not started with a pipe there. */
  stdin: { write(data: string): boolean; on(event: "error", listener: (err: Error) => void): unknown } | null;
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
  /** The PATH of the person's login shell (quadit-cli.ts, loginShellPath), which the server gets. */
  shellPath(): Promise<string>;
}

/** Quadit's own port, taken when it is free at set-up. */
const PREFERRED_PORT = 4780;
const READY_POLL_MS = 250;
const READY_LIMIT_MS = 120_000;
/** The server takes up to 5 s to finish what it is doing when told to stop (internal/app, shutdownTimeout). */
const STOP_LIMIT_MS = 10_000;
/** How long a start waits for its port, which the server before it (the app quit and opened again) may still hold. */
const PORT_WAIT_MS = 8_000;
/** The waits before each start again after the server exited on its own; then it is shown as failed. */
const RESTART_DELAYS_MS = [1_000, 3_000, 10_000];
/** A server that ran this long before it exited gets its starts again back. */
const STEADY_MS = 60_000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
const LOG_LINES = 20;
/** The header that says a request is the app that runs the server: the app key. */
const APP_KEY_HEADER = "X-Quadit-App-Key";
/** The bytes of randomness in an app key (the server refuses fewer than 32), and in a proof's nonce. */
const APP_KEY_BYTES = 32;
/** The workspace the app makes with the owner. */
const FIRST_WORKSPACE = "Personal";
const ASK_LIMIT_MS = 15_000;

export class LocalServer {
  readonly available: boolean;
  readonly dataDir: string;
  readonly logFile: string;
  private current: LocalState = { kind: "stopped" };
  private listeners = new Set<() => void>();
  private settledWaiters: (() => void)[] = [];
  private child: ServerProcess | undefined;
  /** The app key of the server started last, while it runs. */
  private key: string | null = null;
  private exited: Promise<void> = Promise.resolve();
  /** Counts each start and stop: a step of an older one finds it changed and does nothing more. */
  private generation = 0;
  private restarts = 0;
  private runningSince: number | null = null;
  /** The set-up under way, which a second ask while it is gets too. */
  private settingUp: Promise<string> | null = null;

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
   * Once it is no longer starting: whether it runs, so that a window may
   * load its address, or why not. A window that loaded the address while
   * another program held the port would hand that program this server's
   * sign-in.
   */
  async whenRunning(): Promise<{ ok: true } | { ok: false; reason: string }> {
    await this.settled();
    const state = this.current;
    if (state.kind === "running") return { ok: true };
    if (state.kind === "failed") return { ok: false, reason: state.reason };
    return {
      ok: false,
      reason:
        "The server on this computer is stopped. Start it from the server list, or File → Server on This Computer.",
    };
  }

  /**
   * Chooses the server's port the first time (4780 when free, otherwise
   * one the system has free) and starts it; gives its address. Asked again
   * while it is at it, gives the same. Throws where the app has no server
   * to run.
   */
  setUp(): Promise<string> {
    if (!this.available) return Promise.reject(new Error("This build of the app has no Quadit server to run."));
    this.settingUp ??= this.chooseAndStart().finally(() => (this.settingUp = null));
    return this.settingUp;
  }

  /** Starts the server, unless it is starting or running already. Its state says how it goes. */
  start() {
    if (this.current.kind === "starting" || this.current.kind === "running") return;
    this.restarts = 0;
    void this.launch(++this.generation);
  }

  /** Stops the server and waits for it: SIGTERM, then SIGKILL if it has not exited in time. Never starts it again. */
  async stop(): Promise<void> {
    const generation = ++this.generation;
    if (this.child) await this.terminate(this.child, this.exited);
    // Something asked after this stop says what the state is.
    if (generation === this.generation) this.set({ kind: "stopped" });
  }

  /**
   * Tells the server to stop (SIGTERM) and does not wait: for the app's
   * quitting, which must not be held up. The server finishes on its own, and
   * would anyway once the app is gone and its input closes.
   */
  stopWithoutWaiting() {
    this.generation++;
    this.child?.kill("SIGTERM");
  }

  /** Stops the server and starts it again, unless something else was asked of it meanwhile. */
  async restart(): Promise<void> {
    const stopping = this.stop();
    const generation = this.generation;
    await stopping;
    if (generation === this.generation) this.start();
  }

  /**
   * Makes the install's owner, named `name`, and their first workspace
   * ("Personal"), through the session behind `fetch`: the server window's
   * own, so that the session cookie it answers with lands where that window
   * reads it. An install that is set up already is signed in to instead,
   * which makes trying again after a half-finished set-up work; one set up
   * with the web form has no owner the app may sign in, and its window opens
   * on the sign-in page. Gives the workspace made with the owner (its slug),
   * null when the install was set up already, or what went wrong, in a
   * sentence. Never throws.
   */
  async setUpOwner(
    fetch: Fetch,
    name: string,
  ): Promise<{ ok: true; workspace: string | null } | { ok: false; error: string }> {
    const reach = await this.whenRunning();
    if (!reach.ok) return { ok: false, error: reach.reason };
    try {
      const config = await this.ask(fetch, "GET", "/api/v1/auth/config");
      if (!config.ok) return { ok: false, error: await refusal(config) };
      const { setup_needed } = (await config.json()) as { setup_needed?: unknown };
      if (setup_needed === true) {
        const made = await this.ask(fetch, "POST", "/api/v1/auth/setup", { name, workspace_name: FIRST_WORKSPACE });
        if (made.status !== 201) return { ok: false, error: await refusal(made) };
        const { workspace } = (await made.json()) as { workspace?: { slug?: unknown } };
        const slug = typeof workspace?.slug === "string" ? workspace.slug : "";
        return { ok: true, workspace: slug };
      }
      const signedIn = await this.ask(fetch, "POST", "/api/v1/auth/app-session", {});
      if (signedIn.status !== 204 && signedIn.status !== 409) return { ok: false, error: await refusal(signedIn) };
      return { ok: true, workspace: null };
    } catch (err) {
      return {
        ok: false,
        error: `The server on this computer could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Signs the session behind `fetch` (a server window's) in as the
   * install's owner when the server says, in its ordinary way (401
   * "unauthorized"), that it has no session. True when it did just now.
   * False otherwise: signed in already; a second step under way, throttled,
   * a server error or no answer, where the session is left as it is; and
   * when it cannot: the server is not running (proved), it was set up with
   * the web form (409), or it runs without an app key (404). Never throws.
   */
  async signInOwner(fetch: Fetch): Promise<boolean> {
    if ((await this.sessionOf(fetch)) !== "out") return false;
    try {
      return (await this.ask(fetch, "POST", "/api/v1/auth/app-session", {})).status === 204;
    } catch {
      return false;
    }
  }

  /** Whether the session behind `fetch` (a server window's) is signed in on the running server. Never throws. */
  async isSignedIn(fetch: Fetch): Promise<boolean> {
    return (await this.sessionOf(fetch)) === "in";
  }

  /**
   * Whether the running server still waits for the app to set it up (its
   * sign-in options say setup_needed): a set-up the app did not finish,
   * this one or an older version of it. Asked without cookies; false when
   * it is not running or cannot say. Never throws.
   */
  async setupNeeded(): Promise<boolean> {
    const origin = this.origin();
    if (!origin || this.current.kind !== "running") return false;
    try {
      const answer = await this.parts.fetch(`${origin}/api/v1/auth/config`, {
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(ASK_LIMIT_MS),
      });
      if (!answer.ok) return false;
      return ((await answer.json()) as { setup_needed?: unknown }).setup_needed === true;
    } catch {
      return false;
    }
  }

  /**
   * What the running server says of the session behind `fetch`: "in",
   * "out" only on its ordinary not-signed-in answer, and "unknown" for
   * anything else (a second step under way, throttling, an error, no
   * answer, or no server running).
   */
  private async sessionOf(fetch: Fetch): Promise<"in" | "out" | "unknown"> {
    try {
      const me = await this.ask(fetch, "GET", "/api/v1/auth/me");
      if (me.ok) return "in";
      if (me.status !== 401) return "unknown";
      const body = (await me.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      return body?.error?.code === "unauthorized" ? "out" : "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * One request of the running server through `fetch`, with the session's
   * cookies, both ways. A request with a body is a write of the app's own
   * and carries the app key; a read never does.
   */
  private ask(fetch: Fetch, method: "GET" | "POST", path: string, body?: object): Promise<Response> {
    const origin = this.origin();
    // Running is proved: whatever answers there holds this start's key.
    if (!origin || !this.key || this.current.kind !== "running")
      return Promise.reject(new Error("the server is not running"));
    return fetch(origin + path, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json", [APP_KEY_HEADER]: this.key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ASK_LIMIT_MS),
    });
  }

  private async chooseAndStart(): Promise<string> {
    let port = this.parts.settings.get().localPort;
    if (port === null) {
      port = (await this.parts.ports.free(PREFERRED_PORT)) ? PREFERRED_PORT : await this.parts.ports.any();
      this.parts.settings.change({ localPort: port });
    }
    this.start();
    return originOf(port);
  }

  /**
   * Whether what answers at `origin` is the server started with `key`: it
   * makes the HMAC of a fresh nonce with the key (contract §7, "The proof").
   * Asked without the key and without cookies; any other answer, or none, is no.
   */
  private async proves(origin: string, key: string): Promise<boolean> {
    const nonce = randomBytes(APP_KEY_BYTES).toString("base64url");
    try {
      const answer = await this.parts.fetch(`${origin}/api/v1/auth/app-proof`, {
        method: "POST",
        credentials: "omit",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ nonce }),
        signal: AbortSignal.timeout(ASK_LIMIT_MS),
      });
      if (answer.status !== 200) return false;
      const { proof } = (await answer.json()) as { proof?: unknown };
      const expected = Buffer.from(createHmac("sha256", key).update(nonce).digest("hex"));
      const given = Buffer.from(typeof proof === "string" ? proof : "");
      return given.length === expected.length && timingSafeEqual(given, expected);
    } catch {
      return false;
    }
  }

  /** SIGTERM, then SIGKILL when the server has not exited in time; resolves once it has. */
  private async terminate(child: ServerProcess, exited: Promise<void>) {
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

  /** One start of the server, as the start numbered `generation`: whatever goes wrong ends as failed. */
  private async launch(generation: number) {
    try {
      await this.run(generation);
    } catch (err) {
      if (generation === this.generation)
        this.fail(`The server could not be started: ${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  private async run(generation: number) {
    const { binary, settings, spawn, ports, clock, fetch } = this.parts;
    const port = settings.get().localPort;
    if (!binary || port === null) return;
    this.set({ kind: "starting" });
    const waitedFrom = clock.now();
    let free = await ports.free(port);
    while (!free && generation === this.generation && clock.now() - waitedFrom < PORT_WAIT_MS) {
      await clock.sleep(READY_POLL_MS);
      free = await ports.free(port);
    }
    if (!free) {
      if (generation === this.generation) {
        this.fail(
          `Port ${port} on this computer is in use by another program. The server here always uses it, ` +
            "because its address is part of your sign-in and your agents' settings: quit that program, then start the server again.",
          false,
        );
      }
      return;
    }
    const path = await this.parts.shellPath();
    if (generation !== this.generation) return;

    const log = this.openLog();
    const origin = originOf(port);
    let child: ServerProcess;
    try {
      child = spawn(
        binary,
        [
          "serve",
          "--data",
          this.dataDir,
          "--listen",
          `127.0.0.1:${port}`,
          "--url",
          origin,
          "--trusted-proxies=",
          "--stop-on-stdin-close",
          "--app-key-stdin",
        ],
        {
          // Set after the person's own QUADIT_ settings are taken out, on purpose.
          env: { ...withoutQuaditSettings(this.parts.env), PATH: path, QUADIT_SETTING_AUTH_PASSKEYS: "false" },
          stdio: ["pipe", log, log],
        },
      );
    } finally {
      closeSync(log); // the server has its own copy
    }
    const key = randomBytes(APP_KEY_BYTES).toString("base64url");
    // A server that is gone before it reads its key closes its input: the write fails, and its exit says why.
    child.stdin?.on("error", () => {});
    child.stdin?.write(`${key}\n`);
    this.child = child;
    this.key = key;
    let ended = false;
    let exitedNow = () => {};
    const exited = new Promise<void>((done) => (exitedNow = done));
    this.exited = exited;
    const end = (why: string, again: boolean) => {
      if (ended) return;
      ended = true;
      if (this.child === child) {
        this.child = undefined;
        this.key = null;
      }
      exitedNow();
      if (generation === this.generation) void this.exitedOnItsOwn(why, again);
    };
    child.once("exit", (code, signal) =>
      end(`The server stopped unexpectedly (${code !== null ? `exit code ${code}` : `signal ${signal}`}).`, true),
    );
    child.once("error", (err) => end(`The server could not be run: ${err.message}`, false));

    const started = clock.now();
    while (generation === this.generation && !ended) {
      const ready = await fetch(`${origin}/healthz`, { credentials: "omit", signal: AbortSignal.timeout(2_000) })
        .then((response) => response.status === 200)
        .catch(() => false);
      if (generation !== this.generation || ended) return;
      if (ready) {
        const proved = await this.proves(origin, key);
        if (generation !== this.generation || ended) return;
        if (!proved) {
          // Stopped as Stop stops it: its own server, if it is still there, is not left behind a failed state.
          const stopping = ++this.generation;
          await this.terminate(child, exited);
          if (stopping === this.generation) {
            this.fail(
              `Another program answers on port ${port} of this computer, not the Quadit server the app started. ` +
                "Quit that program, then start the server again.",
              true,
            );
          }
          return;
        }
        this.runningSince = clock.now();
        this.set({ kind: "running" });
        return;
      }
      if (clock.now() - started >= READY_LIMIT_MS) {
        // Stopped as Stop stops it, and only then failed: no live server is left behind controls that say it is not.
        const stopping = ++this.generation;
        await this.terminate(child, exited);
        if (stopping === this.generation) this.fail("The server did not start within two minutes.", true);
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

  /** The log's last lines; none when it cannot be read. */
  private lastLogLines(): string[] {
    const size = sizeOf(this.logFile);
    if (!size) return [];
    const length = Math.min(size, 16 * 1024);
    const buffer = Buffer.alloc(length);
    try {
      const fd = openSync(this.logFile, "r");
      try {
        readSync(fd, buffer, 0, length, size - length);
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
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

/** Why the server refused a request, in a sentence: in its own words when its answer has some. */
async function refusal(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  const message = body?.error?.message;
  return typeof message === "string" && message
    ? `The server on this computer answered: ${message}.`
    : `The server on this computer answered with status ${response.status}.`;
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
