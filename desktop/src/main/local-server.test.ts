import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Clock,
  LocalServer,
  type LocalServerParts,
  loopbackPorts,
  type Ports,
  type ServerProcess,
} from "@/main/local-server";
import type { Fetch } from "@/main/probe";
import type { AppSettings } from "@/main/settings";

/** A quadit serve as the app sees it: told signals, given its input, and made to exit by the test. */
class FakeProcess extends EventEmitter implements ServerProcess {
  signals: string[] = [];
  /** What the app wrote to its standard input. */
  input: string[] = [];
  stdin = Object.assign(new EventEmitter(), {
    write: (data: string) => {
      this.input.push(data);
      return true;
    },
  });
  /** Whether it exits when told SIGTERM, as a quadit serve does. */
  constructor(private obeys = true) {
    super();
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (this.obeys || signal === "SIGKILL") queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

/** Time that moves only when the test says. */
class FakeClock implements Clock {
  private at = 0;
  private waiting: { until: number; done: () => void }[] = [];
  now() {
    return this.at;
  }
  sleep(ms: number) {
    return new Promise<void>((done) => this.waiting.push({ until: this.at + ms, done }));
  }
  /** Moves time on by `ms`, waking each sleeper due, and lets what they started run. */
  async advance(ms: number) {
    const end = this.at + ms;
    for (;;) {
      await settle();
      const next = this.waiting.filter((w) => w.until <= end).sort((a, b) => a.until - b.until)[0];
      if (!next) break;
      this.at = next.until;
      this.waiting = this.waiting.filter((w) => w !== next);
      next.done();
    }
    this.at = end;
    await settle();
  }
}

/** Lets promises and I/O callbacks run. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
}

/** A request the app made of the server, as the server saw it. */
interface Asked {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

/** The nonce a proof was asked for with. */
function nonceOf(asked: Asked | undefined): string {
  return (asked?.body as { nonce?: string } | undefined)?.nonce ?? "";
}

function setUp(
  options: {
    taken?: number[];
    ready?: boolean;
    binary?: string | null;
    port?: number | null;
    obeys?: boolean;
    spawn?: () => never;
    /** How what answers at the server's address answers the app's proof: as the server it started, or not. */
    proof?: "right" | "wrong" | "missing" | "away";
    /** What its sign-in options say of set-up. */
    setupNeeded?: boolean;
  } = {},
) {
  const userData = mkdtempSync(join(tmpdir(), "quadit-desktop-local-"));
  let settings: AppSettings = {
    setupDone: true,
    captureShortcut: true,
    lastCapture: null,
    localPort: options.port ?? null,
    pendingFirstRun: null,
  };
  const addressed: Asked[] = [];
  const spawned: { binary: string; args: string[]; env: NodeJS.ProcessEnv; stdio: unknown[]; process: FakeProcess }[] =
    [];
  const clock = new FakeClock();
  const taken = new Set(options.taken ?? []);
  let ready = options.ready ?? true;
  // Each port the system hands out is another, as a real one's would be.
  let nextFree = 51_234;
  const ports: Ports = { free: async (port) => !taken.has(port), any: async () => nextFree++ };
  const parts: LocalServerParts = {
    binary: options.binary === undefined ? "/app/bin/quadit" : options.binary,
    dataDir: join(userData, "server"),
    settings: { get: () => settings, change: (change) => (settings = { ...settings, ...change }) },
    spawn: (binary, args, spawnOptions) => {
      if (options.spawn) options.spawn();
      const process = new FakeProcess(options.obeys);
      spawned.push({ binary, args, env: spawnOptions.env, stdio: spawnOptions.stdio, process });
      return process;
    },
    clock,
    // What answers at the server's address, asked by the app outside any window.
    fetch: async (url, init = {}) => {
      addressed.push({
        url,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        credentials: init.credentials,
      });
      const path = new URL(url).pathname;
      if (!ready) throw new TypeError("fetch failed");
      if (path === "/healthz") return new Response("ok");
      if (path === "/api/v1/auth/config") return json(200, { setup_needed: options.setupNeeded ?? false });
      if (path !== "/api/v1/auth/app-proof") throw new TypeError("fetch failed");
      const proof = options.proof ?? "right";
      if (proof === "away") throw new TypeError("fetch failed");
      if (proof === "missing") return json(404, { error: { code: "not_found", message: "not found" } });
      // The key as the server read it: the first line of its input.
      const key = proof === "right" ? (spawned.at(-1)?.process.input.join("").split("\n")[0] ?? "") : "another key";
      const nonce = nonceOf(addressed.at(-1));
      return json(200, { proof: createHmac("sha256", key).update(nonce).digest("hex") });
    },
    ports,
    env: { PATH: "/usr/bin", HOME: "/home/ann", QUADIT_DB: "postgres://elsewhere", QUADIT_SECRET: "x".repeat(20) },
    shellPath: async () => "/opt/homebrew/bin:/usr/bin:/bin",
  };
  const server = new LocalServer(parts);
  const states: string[] = [];
  server.onChange(() => states.push(server.state().kind));
  return {
    server,
    parts,
    clock,
    spawned,
    states,
    addressed,
    settings: () => settings,
    setReady: (now: boolean) => (ready = now),
    take: (port: number) => taken.add(port),
    release: (port: number) => taken.delete(port),
  };
}

describe("LocalServer", () => {
  it("is not available without a bundled quadit, and says so instead of starting", async () => {
    const { server, spawned } = setUp({ binary: null });
    expect(server.available).toBe(false);
    await expect(server.setUp()).rejects.toThrow("This build of the app has no Quadit server to run");
    expect(spawned).toEqual([]);
  });

  it("takes port 4780 when it is free, and remembers it", async () => {
    const { server, settings } = setUp();
    expect(server.origin()).toBeNull();
    expect(await server.setUp()).toBe("http://127.0.0.1:4780");
    expect(settings().localPort).toBe(4780);
    expect(server.origin()).toBe("http://127.0.0.1:4780");
  });

  it("takes another free port when 4780 is taken, and keeps it even once 4780 is free", async () => {
    const { server, settings, clock, release } = setUp({ taken: [4780] });
    expect(await server.setUp()).toBe("http://127.0.0.1:51234");
    await clock.advance(0);
    await server.stop();
    release(4780);
    expect(await server.setUp()).toBe("http://127.0.0.1:51234");
    expect(settings().localPort).toBe(51234);
  });

  it("runs the bundled quadit on this computer only, with its data folder and log, ended with the app", async () => {
    const { server, parts, spawned, clock, states } = setUp();
    await server.setUp();
    await clock.advance(0);
    expect(spawned).toHaveLength(1);
    const [run] = spawned;
    expect(run?.binary).toBe("/app/bin/quadit");
    expect(run?.args).toEqual([
      "serve",
      "--data",
      parts.dataDir,
      "--listen",
      "127.0.0.1:4780",
      "--url",
      "http://127.0.0.1:4780",
      // Reached only directly: no caller is a proxy whose X-Forwarded-For is believed.
      "--trusted-proxies=",
      "--stop-on-stdin-close",
      "--app-key-stdin",
    ]);
    // The app holds the server's input: when the app goes, however it goes, so does the server.
    expect(run?.stdio[0]).toBe("pipe");
    expect(typeof run?.stdio[1]).toBe("number");
    expect(run?.stdio[2]).toBe(run?.stdio[1]);
    // Nothing of the person's own Quadit settings reaches it; the PATH is the login shell's, where
    // git, ffmpeg and Chrome are found even when the app was opened from the Dock.
    // Passkeys are off: no passkey can be made for an address that is a number (127.0.0.1).
    expect(run?.env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: "/home/ann",
      QUADIT_SETTING_AUTH_PASSKEYS: "false",
    });
    expect(server.state()).toEqual({ kind: "running" });
    expect(states).toEqual(["starting", "running"]);
    expect(statSync(server.logFile).isFile()).toBe(true);
  });

  it("is starting until /healthz answers, and settles once it does", async () => {
    const { server, clock, setReady } = setUp({ ready: false });
    await server.setUp();
    let settled = false;
    void server.settled().then(() => (settled = true));
    await clock.advance(5_000);
    expect(server.state().kind).toBe("starting");
    expect(settled).toBe(false);
    setReady(true);
    await clock.advance(1_000);
    expect(server.state().kind).toBe("running");
    expect(settled).toBe(true);
  });

  it("gives up on a server that is not ready in two minutes, and stops it", async () => {
    const { server, clock, spawned } = setUp({ ready: false });
    await server.setUp();
    await clock.advance(121_000);
    expect(server.state()).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("did not start"),
      log: [expect.stringMatching(/^Started by the Quadit app at /)],
    });
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM"]);
  });

  it("waits a few seconds for its port, as the server before it lets go of it, and then starts", async () => {
    const { server, spawned, take, release, clock } = setUp({ port: 4780 });
    take(4780);
    server.start();
    await clock.advance(3_000);
    expect(spawned).toEqual([]);
    expect(server.state().kind).toBe("starting");
    release(4780);
    await clock.advance(500);
    expect(spawned).toHaveLength(1);
    expect(server.state().kind).toBe("running");
  });

  it("refuses to start when its port stays taken, with a clear reason, and does not move", async () => {
    const { server, spawned, take, clock } = setUp({ port: 4780 });
    take(4780);
    server.start();
    await clock.advance(7_999);
    expect(server.state().kind).toBe("starting");
    await clock.advance(1);
    await server.settled();
    expect(spawned).toEqual([]);
    expect(server.state()).toMatchObject({
      kind: "failed",
      reason: expect.stringMatching(/^Port 4780 on this computer is in use by another program/),
    });
    expect(server.origin()).toBe("http://127.0.0.1:4780");
  });

  it("starts a server that exits unexpectedly again a few times, a little later each time, then fails with its last log lines", async () => {
    const { server, clock, spawned } = setUp();
    await server.setUp();
    await clock.advance(0);
    const crash = () => {
      writeFileSync(server.logFile, 'level=ERROR msg="database is locked"\n', { flag: "a" });
      spawned.at(-1)?.process.emit("exit", 1, null);
    };
    for (const wait of [1_000, 3_000, 10_000]) {
      crash();
      await clock.advance(wait - 1);
      expect(server.state().kind).toBe("starting");
      const before = spawned.length;
      await clock.advance(1);
      expect(spawned.length).toBe(before + 1);
    }
    crash();
    await clock.advance(60_000);
    expect(spawned).toHaveLength(4);
    const state = server.state();
    expect(state).toMatchObject({ kind: "failed", reason: "The server stopped unexpectedly (exit code 1)." });
    expect(state.kind === "failed" && state.log.at(-1)).toBe('level=ERROR msg="database is locked"');
  });

  it("gives a server that ran a good while its restarts back", async () => {
    const { server, clock, spawned } = setUp();
    await server.setUp();
    await clock.advance(0);
    for (let i = 0; i < 5; i++) {
      await clock.advance(10 * 60_000);
      spawned.at(-1)?.process.emit("exit", null, "SIGSEGV");
      await clock.advance(1_000);
      expect(server.state().kind).toBe("running");
    }
    expect(spawned).toHaveLength(6);
  });

  it("stops with SIGTERM and waits for the server, without starting it again", async () => {
    const { server, clock, spawned, states } = setUp();
    await server.setUp();
    await clock.advance(0);
    await server.stop();
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM"]);
    expect(server.state()).toEqual({ kind: "stopped" });
    await clock.advance(60_000);
    expect(spawned).toHaveLength(1);
    expect(states.at(-1)).toBe("stopped");
  });

  it("is told to stop without being waited for when the app quits, and is not started again", async () => {
    const { server, clock, spawned } = setUp({ obeys: false });
    await server.setUp();
    await clock.advance(0);
    server.stopWithoutWaiting();
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM"]);
    spawned[0]?.process.emit("exit", 0, null);
    await clock.advance(60_000);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM"]);
  });

  it("kills a server that does not stop in time", async () => {
    const { server, clock, spawned } = setUp({ obeys: false });
    await server.setUp();
    await clock.advance(0);
    const stopped = server.stop();
    await clock.advance(9_999);
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM"]);
    await clock.advance(1);
    await stopped;
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(server.state().kind).toBe("stopped");
  });

  it("does not start again after a stop asked for while it waited to", async () => {
    const { server, clock, spawned } = setUp();
    await server.setUp();
    await clock.advance(0);
    spawned[0]?.process.emit("exit", 2, null);
    await clock.advance(500);
    await server.stop();
    await clock.advance(60_000);
    expect(spawned).toHaveLength(1);
    expect(server.state().kind).toBe("stopped");
  });

  it("restarts: stops the running server and starts a new one", async () => {
    const { server, clock, spawned } = setUp();
    await server.setUp();
    await clock.advance(0);
    const restarted = server.restart();
    await clock.advance(0);
    await restarted;
    await clock.advance(0);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM"]);
    expect(server.state().kind).toBe("running");
  });

  it("says why a server could not be run at all", async () => {
    const { server, clock, spawned } = setUp({ ready: false });
    await server.setUp();
    await clock.advance(0);
    spawned[0]?.process.emit("error", Object.assign(new Error("spawn /app/bin/quadit EACCES"), { code: "EACCES" }));
    await clock.advance(60_000);
    expect(server.state()).toMatchObject({
      kind: "failed",
      reason: "The server could not be run: spawn /app/bin/quadit EACCES",
    });
    expect(spawned).toHaveLength(1);
  });

  it("starts a new log when the last one grew large, keeping one before it", async () => {
    const { server, parts, clock } = setUp();
    mkdirSync(parts.dataDir, { recursive: true });
    writeFileSync(server.logFile, "x".repeat(5 * 1024 * 1024 + 1));
    await server.setUp();
    await clock.advance(0);
    expect(statSync(`${server.logFile}.1`).size).toBe(5 * 1024 * 1024 + 1);
    expect(readFileSync(server.logFile, "utf8")).toMatch(/^Started by the Quadit app at /);
  });

  it("is reachable for a window only while it runs, and says why not otherwise", async () => {
    const { server, clock, take } = setUp({ port: 4780 });
    expect(await server.whenRunning()).toEqual({ ok: false, reason: expect.stringMatching(/is stopped/) });
    server.start();
    let answer: unknown;
    void server.whenRunning().then((said) => (answer = said));
    await clock.advance(0);
    expect(answer).toEqual({ ok: true });

    // Another program on its port: the window must not go there, with this server's sign-in.
    await server.stop();
    take(4780);
    server.start();
    void server.whenRunning().then((said) => (answer = said));
    await clock.advance(10_000);
    expect(answer).toEqual({ ok: false, reason: expect.stringMatching(/^Port 4780 on this computer is in use/) });
  });

  it("does not start again after a restart when a stop was asked while the old server was still going", async () => {
    const { server, clock, spawned } = setUp({ obeys: false });
    await server.setUp();
    await clock.advance(0);
    const restarted = server.restart();
    const stopped = server.stop();
    spawned[0]?.process.emit("exit", 0, null);
    await Promise.all([restarted, stopped]);
    await clock.advance(60_000);
    expect(spawned).toHaveLength(1);
    expect(server.state().kind).toBe("stopped");
  });

  it("fails with a plain reason when it cannot be started at all", async () => {
    const { server, parts, clock } = setUp();
    // A file where its data folder should be: its log cannot be opened.
    writeFileSync(parts.dataDir, "");
    await server.setUp();
    await clock.advance(0);
    expect(server.state()).toMatchObject({
      kind: "failed",
      reason: expect.stringMatching(/^The server could not be started: /),
    });

    const throwing = setUp({
      spawn: () => {
        throw new Error("spawn EBADF");
      },
    });
    await throwing.server.setUp();
    await throwing.clock.advance(0);
    expect(throwing.server.state()).toMatchObject({
      kind: "failed",
      reason: "The server could not be started: spawn EBADF",
    });
  });

  it("stops a server that was never ready the way Stop does, killing it if it must, before showing it failed", async () => {
    const { server, clock, spawned } = setUp({ ready: false, obeys: false });
    await server.setUp();
    await clock.advance(120_000);
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM"]);
    expect(server.state().kind).toBe("starting");
    await clock.advance(10_000);
    expect(spawned[0]?.process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(server.state()).toMatchObject({ kind: "failed", reason: "The server did not start within two minutes." });
  });

  it("is set up once when asked twice at the same time, on one port", async () => {
    const { server, clock, spawned, settings } = setUp({ taken: [4780] });
    const [first, second] = await Promise.all([server.setUp(), server.setUp()]);
    await clock.advance(0);
    expect(first).toBe("http://127.0.0.1:51234");
    expect(second).toBe(first);
    expect(settings().localPort).toBe(51234);
    expect(spawned).toHaveLength(1);
  });
});

/**
 * The server on this computer as a window's session reaches it: each answer
 * is given by `answer` from the path and the request, and every request is
 * kept as the server saw it.
 */
function windowSession(answer: (path: string, asked: Asked) => Response) {
  const asked: Asked[] = [];
  const fetch: Fetch = async (url, init = {}) => {
    const request: Asked = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      credentials: init.credentials,
    };
    asked.push(request);
    return answer(new URL(url).pathname, request);
  };
  return { fetch, asked };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A server that runs, as setUp makes it, and the key it was given on its input. */
async function running() {
  const made = setUp();
  await made.server.setUp();
  await made.clock.advance(0);
  const key = () => (made.spawned.at(-1)?.process.input.join("") ?? "").replace(/\n$/, "");
  return { ...made, key };
}

describe("LocalServer's proof", () => {
  it("counts the server as running only once it has proved, with a fresh nonce, that it holds this start's key", async () => {
    const { server, clock, addressed, states } = setUp();
    await server.setUp();
    await clock.advance(0);
    expect(server.state().kind).toBe("running");
    expect(states).toEqual(["starting", "running"]);
    const proofs = () => addressed.filter((asked) => asked.url.endsWith("/api/v1/auth/app-proof"));
    expect(proofs()).toHaveLength(1);
    const [asked] = proofs();
    expect(asked).toMatchObject({
      url: "http://127.0.0.1:4780/api/v1/auth/app-proof",
      method: "POST",
      credentials: "omit",
    });
    // The key itself never goes there: only what the server makes of the nonce with it comes back.
    expect(asked?.headers.has("X-Quadit-App-Key")).toBe(false);
    const nonce = nonceOf(asked);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await server.restart();
    await clock.advance(0);
    expect(proofs()).toHaveLength(2);
    expect(nonceOf(proofs()[1])).not.toBe(nonce);
  });

  for (const [proof, what] of [
    ["wrong", "a proof made with another key"],
    ["missing", "no proof (404)"],
    ["away", "no answer to the proof"],
  ] as const) {
    it(`fails the start on ${what}: another program answers there, which is stopped being asked anything`, async () => {
      const { server, clock, spawned, addressed } = setUp({ proof });
      await server.setUp();
      await clock.advance(0);
      expect(server.state()).toMatchObject({
        kind: "failed",
        reason:
          "Another program answers on port 4780 of this computer, not the Quadit server the app started. " +
          "Quit that program, then start the server again.",
      });
      // Its own server is stopped, and not started again by itself.
      expect(spawned[0]?.process.signals).toEqual(["SIGTERM"]);
      await clock.advance(60_000);
      expect(spawned).toHaveLength(1);
      // Nothing with the key or cookies went there, and the owner's calls ask nothing.
      expect(addressed.map((asked) => new URL(asked.url).pathname)).toEqual(["/healthz", "/api/v1/auth/app-proof"]);
      const session = windowSession(() => json(200, {}));
      expect(await server.signInOwner(session.fetch)).toBe(false);
      expect(await server.setUpOwner(session.fetch, "Lou")).toMatchObject({ ok: false });
      expect(session.asked).toEqual([]);
    });
  }
});

describe("LocalServer.setupNeeded", () => {
  it("says whether the running server still waits for the app to set it up, asked without cookies", async () => {
    const waiting = setUp({ setupNeeded: true });
    await waiting.server.setUp();
    await waiting.clock.advance(0);
    expect(await waiting.server.setupNeeded()).toBe(true);
    expect(waiting.addressed.at(-1)).toMatchObject({
      url: "http://127.0.0.1:4780/api/v1/auth/config",
      credentials: "omit",
    });

    const done = setUp({ setupNeeded: false });
    await done.server.setUp();
    await done.clock.advance(0);
    expect(await done.server.setupNeeded()).toBe(false);
  });

  it("asks nothing of a server that is not running, and is false when it cannot say", async () => {
    const stopped = setUp({ port: 4780 });
    expect(await stopped.server.setupNeeded()).toBe(false);
    expect(stopped.addressed).toEqual([]);

    const { server, clock, setReady } = setUp({ setupNeeded: true });
    await server.setUp();
    await clock.advance(0);
    setReady(false);
    expect(await server.setupNeeded()).toBe(false);
  });
});

describe("LocalServer's app key", () => {
  it("is new at every start, given as the first line of the server's input, and written nowhere else", async () => {
    const { server, spawned, clock, settings, key } = await running();
    const first = key();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(spawned[0]?.process.input).toEqual([`${first}\n`]);

    await server.restart();
    await clock.advance(0);
    expect(spawned).toHaveLength(2);
    expect(key()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key()).not.toBe(first);

    for (const run of spawned) {
      expect(JSON.stringify(run.args)).not.toContain(first);
      expect(JSON.stringify(run.env)).not.toContain(first);
    }
    expect(JSON.stringify(settings())).not.toContain(first);
    expect(readFileSync(server.logFile, "utf8")).not.toContain(first);
  });

  it("does not bring the app down when the server's input is already closed: its exit says what happened", async () => {
    const { server, spawned, clock } = await running();
    spawned[0]?.process.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    spawned[0]?.process.emit("exit", 1, null);
    await clock.advance(0);
    expect(server.state().kind).toBe("starting");
  });
});

describe("LocalServer.setUpOwner", () => {
  it("makes the owner and the workspace Personal with the app key, through the session it is given", async () => {
    const { server, key } = await running();
    const session = windowSession((path) => {
      if (path === "/api/v1/auth/config") return json(200, { setup_needed: true, setup_by_app: true });
      if (path === "/api/v1/auth/setup")
        return json(201, { user: { name: "Lou Local" }, workspace: { slug: "personal", name: "Personal" } });
      return json(404, {});
    });
    expect(await server.setUpOwner(session.fetch, "Lou Local")).toEqual({ ok: true, workspace: "personal" });
    const made = session.asked.find((asked) => asked.url.endsWith("/api/v1/auth/setup"));
    expect(made).toMatchObject({
      url: "http://127.0.0.1:4780/api/v1/auth/setup",
      method: "POST",
      body: { name: "Lou Local", workspace_name: "Personal" },
      // The cookie it answers with lands in the window's own session.
      credentials: "include",
    });
    expect(made?.headers.get("X-Quadit-App-Key")).toBe(key());
    // Nothing else is sent the key.
    expect(session.asked.filter((asked) => asked.headers.has("X-Quadit-App-Key"))).toHaveLength(1);
  });

  it("signs in instead on an install set up already, so trying again after a half-finished set-up works", async () => {
    const { server, key } = await running();
    const session = windowSession((path) => {
      if (path === "/api/v1/auth/config") return json(200, { setup_needed: false });
      if (path === "/api/v1/auth/app-session") return new Response(null, { status: 204 });
      return json(404, {});
    });
    expect(await server.setUpOwner(session.fetch, "Lou Local")).toEqual({ ok: true, workspace: null });
    expect(session.asked.some((asked) => asked.url.endsWith("/api/v1/auth/setup"))).toBe(false);
    const signedIn = session.asked.find((asked) => asked.url.endsWith("/api/v1/auth/app-session"));
    expect(signedIn).toMatchObject({ method: "POST", credentials: "include" });
    expect(signedIn?.headers.get("X-Quadit-App-Key")).toBe(key());
  });

  it("opens the sign-in page of an install that was set up with the form, which has no owner the app may sign in", async () => {
    const { server } = await running();
    const session = windowSession((path) =>
      path === "/api/v1/auth/config"
        ? json(200, { setup_needed: false })
        : json(409, { error: { code: "conflict", message: "this install has no local owner" } }),
    );
    expect(await server.setUpOwner(session.fetch, "Lou Local")).toEqual({ ok: true, workspace: null });
  });

  it("says plainly why it could not, in the server's words when it gave some", async () => {
    const { server } = await running();
    const refusing = windowSession((path) =>
      path === "/api/v1/auth/config"
        ? json(200, { setup_needed: true })
        : json(400, { error: { code: "invalid", field: "name", message: "name is required" } }),
    );
    expect(await server.setUpOwner(refusing.fetch, "")).toEqual({
      ok: false,
      error: "The server on this computer answered: name is required.",
    });

    const silent = windowSession(() => new Response("", { status: 502 }));
    expect(await server.setUpOwner(silent.fetch, "Lou")).toEqual({
      ok: false,
      error: "The server on this computer answered with status 502.",
    });

    const away = windowSession(() => {
      throw new TypeError("fetch failed");
    });
    expect(await server.setUpOwner(away.fetch, "Lou")).toEqual({
      ok: false,
      error: "The server on this computer could not be reached: fetch failed",
    });
  });

  it("asks nothing of a server that is not running", async () => {
    const { server } = setUp({ port: 4780 });
    const session = windowSession(() => json(200, {}));
    expect(await server.setUpOwner(session.fetch, "Lou")).toEqual({
      ok: false,
      error: expect.stringMatching(/is stopped/),
    });
    expect(session.asked).toEqual([]);
  });
});

describe("LocalServer.isSignedIn", () => {
  it("is whether the session behind the fetch is signed in on the running server", async () => {
    const { server } = await running();
    expect(await server.isSignedIn(windowSession(() => json(200, { user: {} })).fetch)).toBe(true);
    expect(await server.isSignedIn(windowSession(() => json(401, { error: { code: "unauthorized" } })).fetch)).toBe(
      false,
    );
    expect(await server.isSignedIn(windowSession(() => json(503, {})).fetch)).toBe(false);
  });

  it("asks nothing of a server that is not running", async () => {
    const { server } = setUp({ port: 4780 });
    const session = windowSession(() => json(200, {}));
    expect(await server.isSignedIn(session.fetch)).toBe(false);
    expect(session.asked).toEqual([]);
  });
});

describe("LocalServer.signInOwner", () => {
  it("leaves a session that is signed in alone", async () => {
    const { server } = await running();
    const session = windowSession((path) => (path === "/api/v1/auth/me" ? json(200, { user: {} }) : json(500, {})));
    expect(await server.signInOwner(session.fetch)).toBe(false);
    expect(session.asked.map((asked) => `${asked.method} ${new URL(asked.url).pathname}`)).toEqual([
      "GET /api/v1/auth/me",
    ]);
    expect(session.asked[0]?.credentials).toBe("include");
    expect(session.asked[0]?.headers.has("X-Quadit-App-Key")).toBe(false);
  });

  it("asks for the owner's session with the app key when the server says, in its ordinary way, that there is none", async () => {
    const { server, key } = await running();
    const session = windowSession((path) =>
      path === "/api/v1/auth/me"
        ? json(401, { error: { code: "unauthorized", message: "sign in first" } })
        : new Response(null, { status: 204 }),
    );
    expect(await server.signInOwner(session.fetch)).toBe(true);
    const asked = session.asked.at(-1);
    expect(asked).toMatchObject({
      url: "http://127.0.0.1:4780/api/v1/auth/app-session",
      method: "POST",
      credentials: "include",
    });
    expect(asked?.headers.get("X-Quadit-App-Key")).toBe(key());
  });

  it("leaves the session as it is on any other answer about it: a second step under way, throttled, a server error, or none", async () => {
    const { server } = await running();
    const answers = [
      () => json(401, { error: { code: "second_step", message: "finish signing in with your second step" } }),
      () => json(403, { error: { code: "second_step_required", message: "set it up first" } }),
      () => json(429, { error: { code: "rate_limited", message: "slow down" } }),
      () => json(503, { error: { code: "unavailable", message: "try again later" } }),
      () => new Response("not json", { status: 401 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const answer of answers) {
      const session = windowSession((path) =>
        path === "/api/v1/auth/me" ? answer() : new Response(null, { status: 204 }),
      );
      expect(await server.signInOwner(session.fetch)).toBe(false);
      expect(session.asked.some((asked) => asked.method === "POST")).toBe(false);
    }
  });

  it("is not signed in by any other answer: set up with the form (409), no key (404), a wrong key (403), or no answer", async () => {
    const { server } = await running();
    for (const status of [409, 404, 403, 429, 500]) {
      const session = windowSession((path) =>
        path === "/api/v1/auth/me"
          ? json(401, { error: { code: "unauthorized" } })
          : json(status, { error: { code: "x", message: "no" } }),
      );
      expect(await server.signInOwner(session.fetch), String(status)).toBe(false);
    }
    const away = windowSession((path) => {
      if (path === "/api/v1/auth/me") return json(401, { error: { code: "unauthorized" } });
      throw new TypeError("fetch failed");
    });
    expect(await server.signInOwner(away.fetch)).toBe(false);
  });

  it("asks nothing of a server that is not running", async () => {
    const { server } = setUp({ port: 4780 });
    const session = windowSession(() => json(401, {}));
    expect(await server.signInOwner(session.fetch)).toBe(false);
    expect(session.asked).toEqual([]);
  });
});

describe("loopbackPorts", () => {
  it("says a port something listens on is taken, and free once it stops", async () => {
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(await loopbackPorts.free(port)).toBe(false);
    await new Promise((done) => listener.close(done));
    expect(await loopbackPorts.free(port)).toBe(true);
  });

  it("finds a free port", async () => {
    const port = await loopbackPorts.any();
    expect(port).toBeGreaterThan(0);
    expect(await loopbackPorts.free(port)).toBe(true);
  });
});
