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
import type { AppSettings } from "@/main/settings";

/** A quadit serve as the app sees it: told signals, and made to exit by the test. */
class FakeProcess extends EventEmitter implements ServerProcess {
  signals: string[] = [];
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

function setUp(
  options: {
    taken?: number[];
    ready?: boolean;
    binary?: string | null;
    port?: number | null;
    obeys?: boolean;
  } = {},
) {
  const userData = mkdtempSync(join(tmpdir(), "quadit-desktop-local-"));
  let settings: AppSettings = {
    setupDone: true,
    captureShortcut: true,
    lastCapture: null,
    localPort: options.port ?? null,
  };
  const spawned: { binary: string; args: string[]; env: NodeJS.ProcessEnv; stdio: unknown[]; process: FakeProcess }[] =
    [];
  const clock = new FakeClock();
  const taken = new Set(options.taken ?? []);
  let ready = options.ready ?? true;
  const ports: Ports = { free: async (port) => !taken.has(port), any: async () => 51_234 };
  const parts: LocalServerParts = {
    binary: options.binary === undefined ? "/app/bin/quadit" : options.binary,
    dataDir: join(userData, "server"),
    settings: { get: () => settings, change: (change) => (settings = { ...settings, ...change }) },
    spawn: (binary, args, spawnOptions) => {
      const process = new FakeProcess(options.obeys);
      spawned.push({ binary, args, env: spawnOptions.env, stdio: spawnOptions.stdio, process });
      return process;
    },
    clock,
    fetch: async (url) => {
      if (!ready || !url.endsWith("/readyz")) throw new TypeError("fetch failed");
      return new Response("ok");
    },
    ports,
    env: { PATH: "/usr/bin", HOME: "/home/ann", QUADIT_DB: "postgres://elsewhere", QUADIT_SECRET: "x".repeat(20) },
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
    settings: () => settings,
    setReady: (now: boolean) => (ready = now),
    take: (port: number) => taken.add(port),
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
    const { server, settings, clock } = setUp({ taken: [4780] });
    expect(await server.setUp()).toBe("http://127.0.0.1:51234");
    await clock.advance(0);
    await server.stop();
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
      "--stop-on-stdin-close",
    ]);
    // The app holds the server's input: when the app goes, however it goes, so does the server.
    expect(run?.stdio[0]).toBe("pipe");
    expect(typeof run?.stdio[1]).toBe("number");
    expect(run?.stdio[2]).toBe(run?.stdio[1]);
    // Nothing of the person's own Quadit settings reaches it.
    expect(run?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/ann" });
    expect(server.state()).toEqual({ kind: "running" });
    expect(states).toEqual(["starting", "running"]);
    expect(statSync(server.logFile).isFile()).toBe(true);
  });

  it("is starting until /readyz answers, and settles once it does", async () => {
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

  it("refuses to start when its port is taken, with a clear reason, and does not move", async () => {
    const { server, spawned, take } = setUp({ port: 4780 });
    take(4780);
    server.start();
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
    const { server, clock, spawned } = setUp();
    await server.setUp();
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
