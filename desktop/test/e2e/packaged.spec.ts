// The app electron-builder made (pnpm dist), for this Mac: what only the
// packaged app has. It cannot be driven like the app run from source:
// Playwright attaches through the inspector and a DevTools port, which the
// packaged app refuses (src/main/switches.ts, and its Electron fuses). So it
// is started as a person starts it, and watched from outside.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { expect, test } from "./desktop";

const APP = join(__dirname, "../../dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Quadit.app");
const BINARY = join(APP, "Contents/MacOS/Quadit");
/** A fuse's state as the binary holds it: the characters "1" and "0" (@electron/fuses' FuseState, which it does not export). */
const ON = "1".charCodeAt(0);
const OFF = "0".charCodeAt(0);

test.skip(process.platform !== "darwin" || !existsSync(BINARY), "no packaged app: run pnpm dist first");

/** Starts the packaged app on a data folder of its own (holding `servers` when given), with `args` and `env`. */
function start(
  args: string[] = [],
  env: Record<string, string> = {},
  servers?: unknown[],
): { app: ChildProcess; data: string } {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-packaged-"));
  if (servers) writeFileSync(join(data, "servers.json"), JSON.stringify({ servers }));
  // Cookies are encrypted with a key in the login keychain, which asks the person before it lets an
  // app with another signature in (each unsigned build has its own): the test keeps to Chromium's stand-in.
  const app = spawn(BINARY, ["--use-mock-keychain", ...args], {
    env: { ...process.env, ...env, QUADIT_DESKTOP_DATA: data },
    stdio: "pipe",
  });
  return { app, data };
}

function exitOf(app: ChildProcess): Promise<number | null> {
  return new Promise((done) => (app.exitCode !== null ? done(app.exitCode) : app.once("exit", done)));
}

async function stop(app: ChildProcess) {
  if (app.exitCode !== null) return;
  const exited = exitOf(app);
  app.kill("SIGTERM");
  const killed = setTimeout(() => app.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(killed);
}

/** A server of the test's own, that only the app started here asks: it notes each asker's user agent. */
async function ownServer(): Promise<{ origin: string; agents: string[]; close(): void }> {
  const agents: string[] = [];
  const server = createServer((req, res) => {
    agents.push(req.headers["user-agent"] ?? "");
    res.end("");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    agents,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Whether anything listens on the port. */
function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

test("the packaged app claims quadit:// links and has the fuses that keep other programs out", async () => {
  const types = execFileSync("plutil", [
    "-extract",
    "CFBundleURLTypes",
    "json",
    "-o",
    "-",
    join(APP, "Contents/Info.plist"),
  ]);
  expect(JSON.parse(types.toString())).toEqual([expect.objectContaining({ CFBundleURLSchemes: ["quadit"] })]);
  const fuses = await getCurrentFuseWire(BINARY);
  expect({
    runAsNode: fuses[FuseV1Options.RunAsNode],
    nodeOptions: fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable],
    inspect: fuses[FuseV1Options.EnableNodeCliInspectArguments],
    asarIntegrity: fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
    onlyAsar: fuses[FuseV1Options.OnlyLoadAppFromAsar],
    cookieEncryption: fuses[FuseV1Options.EnableCookieEncryption],
  }).toEqual({
    runAsNode: OFF,
    nodeOptions: OFF,
    inspect: OFF,
    asarIntegrity: ON,
    onlyAsar: ON,
    cookieEncryption: ON,
  });
});

test("the packaged app starts and opens the server that was open, as the app", async () => {
  const server = await ownServer();
  const { app } = start([], {}, [{ id: "a1b2c3d4e5f6", name: "Own", origin: server.origin, open: true, handoff: 1 }]);
  try {
    await expect
      .poll(() => server.agents, { timeout: 30_000 })
      .toContainEqual(expect.stringMatching(/ QuaditDesktop\/0\.1\.0$/));
    expect(app.exitCode).toBeNull();
  } finally {
    await stop(app);
    server.close();
  }
});

test("the packaged app refuses to start with a DevTools port or the inspector", async () => {
  for (const flag of ["--remote-debugging-port", "--inspect"]) {
    const port = 39_000 + Math.floor(Math.random() * 1000);
    const { app } = start([`${flag}=${port}`]);
    let stderr = "";
    app.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      expect(await exitOf(app), flag).toBe(1);
      expect(stderr).toContain(`does not start with ${flag}`);
      expect(await listening(port), `${flag}: something listens on ${port}`).toBe(false);
    } finally {
      await stop(app);
    }
  }
});

test("the packaged app is no Node.js for whoever sets ELECTRON_RUN_AS_NODE", async () => {
  // As the app, it opens its window on its server; as Node, it would print, exit and ask nothing.
  const server = await ownServer();
  const { app } = start(["-e", "process.stdout.write('ran as node'); process.exit(7)"], { ELECTRON_RUN_AS_NODE: "1" }, [
    { id: "b1c2d3e4f5a6", name: "Own", origin: server.origin, open: true, handoff: 1 },
  ]);
  let stdout = "";
  app.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  try {
    await expect.poll(() => server.agents.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(stdout).not.toContain("ran as node");
    expect(app.exitCode).toBeNull();
  } finally {
    await stop(app);
    server.close();
  }
});
