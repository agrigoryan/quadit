// The app electron-builder made (pnpm dist), for this Mac: what only the
// packaged app has. It cannot be driven like the app run from source:
// Playwright attaches through the inspector and a DevTools port, which the
// packaged app refuses (src/main/switches.ts, and its Electron fuses). So it
// is started as a person starts it, and watched from outside.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { APP_VERSION, expect, test } from "./desktop";

const APP = join(__dirname, "../../dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Quadit.app");
const BINARY = join(APP, "Contents/MacOS/Quadit");
/** A fuse's state as the binary holds it: the characters "1" and "0" (@electron/fuses' FuseState, which it does not export). */
const ON = "1".charCodeAt(0);
const OFF = "0".charCodeAt(0);

// On CI (desktop-ci.yml packages the app first) a missing app fails the tests rather than skipping them.
test.skip(
  process.platform !== "darwin" || (!existsSync(BINARY) && !process.env.CI),
  "no packaged app: run pnpm dist first",
);

/** Starts the packaged app on a data folder of its own (holding `servers` when given), with `args` and `env`. */
function start(
  args: string[] = [],
  env: Record<string, string> = {},
  servers?: unknown[],
): { app: ChildProcess; data: string } {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-packaged-"));
  if (servers) writeFileSync(join(data, "servers.json"), JSON.stringify({ servers }));
  writeFileSync(join(data, "settings.json"), JSON.stringify({ setupDone: true }));
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

test("the packaged app carries Quadit's licence and those of Electron and of Chromium", () => {
  expect(readFileSync(join(APP, "Contents/Resources/LICENSE"), "utf8")).toBe(
    readFileSync(join(__dirname, "../../../LICENSE"), "utf8"),
  );
  for (const file of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
    expect(existsSync(join(APP, "Contents/Resources", file)), file).toBe(true);
  }
});

test("the packaged app carries the quadit command for its architecture, which Connect links onto the PATH", () => {
  const cli = join(APP, "Contents/Resources/bin/quadit");
  expect(execFileSync(cli, ["version"], { encoding: "utf8" })).toMatch(/^quadit \S+ \(agent surface/);
  expect(execFileSync("file", [cli], { encoding: "utf8" })).toContain(process.arch === "arm64" ? "arm64" : "x86_64");
});

test("the quadit it carries serves the web app, takes the app key on its input, and stops when its input closes, as the app runs it", async () => {
  const cli = join(APP, "Contents/Resources/bin/quadit");
  const free = createServer();
  await new Promise<void>((done) => free.listen(0, "127.0.0.1", done));
  const address = free.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((done) => free.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-packaged-server-"));
  const server = spawn(
    cli,
    [
      "serve",
      "--data",
      data,
      "--listen",
      `127.0.0.1:${port}`,
      "--url",
      origin,
      "--stop-on-stdin-close",
      "--app-key-stdin",
    ],
    { stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH ?? "", HOME: data } },
  );
  server.stdin?.write(`${randomBytes(32).toString("base64url")}\n`);
  try {
    await expect
      .poll(
        () =>
          fetch(`${origin}/readyz`).then(
            (r) => r.status,
            () => 0,
          ),
        { timeout: 20_000 },
      )
      .toBe(200);
    expect(await (await fetch(`${origin}/setup`)).text()).toContain('<div id="root">');
    // Set up by the app that runs it, not by the web form.
    const signIn = (await (await fetch(`${origin}/api/v1/auth/config`)).json()) as { setup_by_app?: boolean };
    expect(signIn.setup_by_app).toBe(true);
    server.stdin?.end();
    expect(await exitOf(server)).toBe(0);
  } finally {
    await stop(server);
  }
});

test("the packaged app starts and opens the server that was open, as the app", async () => {
  const server = await ownServer();
  const { app } = start([], {}, [{ id: "a1b2c3d4e5f6", name: "Own", origin: server.origin, open: true, handoff: 1 }]);
  try {
    await expect
      .poll(() => server.agents.map((agent) => agent.split(" ").at(-1)), { timeout: 30_000 })
      .toContain(`QuaditDesktop/${APP_VERSION}`);
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
