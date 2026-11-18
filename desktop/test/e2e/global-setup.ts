// Starts what the desktop tests talk to, once for the run: a real Quadit
// server (the binary `make build` made, on a free port, with a new empty
// data directory), its owner and workspace made through the first-run API,
// an API token for the CLI, and the hand-off stand-in in front of it
// (handoff-fake.ts). Everything is handed to the tests through
// QUADIT_DESKTOP_E2E (see desktop.ts); the function returned stops it all.
//
// The tests sign in through the real server's own hand-off. With
// QUADIT_DESKTOP_HANDOFF_STANDIN=1 they sign in through the stand-in's
// instead, which checks the app against the contract alone.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHandoffFake } from "./handoff-fake";
import { BINARY, OWNER, type Run, WORKSPACE } from "./run";

export default async function globalSetup() {
  const binary = process.env.QUADIT_BINARY || BINARY;
  if (!existsSync(binary))
    throw new Error(`No Quadit binary at ${binary}. Build it first: make build (in the repository root).`);
  const dir = await mkdtemp(join(tmpdir(), "quadit-desktop-e2e-"));
  const port = await freePort();
  const direct = `http://127.0.0.1:${port}`;
  const standIn = process.env.QUADIT_DESKTOP_HANDOFF_STANDIN === "1";
  // The stand-in's port must be known before the server starts: it is the server's public address.
  const fake = await startHandoffFake(direct, OWNER);
  const server = spawn(
    binary,
    ["serve", "--listen", `127.0.0.1:${port}`, "--data", join(dir, "data"), "--url", standIn ? fake.url : direct],
    {
      stdio: ["ignore", "ignore", "pipe"],
      // Nothing from the shell that started the run may point it elsewhere.
      env: { PATH: process.env.PATH ?? "", HOME: dir, QUADIT_CONFIG: join(dir, "cli.json") },
    },
  );
  let log = "";
  server.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const stop = async () => {
    await fake.close();
    await stopServer(server);
    if (process.env.QUADIT_DESKTOP_E2E_LOG) process.stderr.write(log);
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitUntilUp(direct, server, () => log);
    const setUp = await fetch(`${direct}/api/v1/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        name: OWNER.name,
        email: OWNER.email,
        password: OWNER.password,
        workspace_name: WORKSPACE.name,
      }),
    });
    if (!setUp.ok) throw new Error(`setup: ${setUp.status} ${await setUp.text()}`);
    // The owner's session from the first run: tests that only need to be signed in reuse it, since
    // the server allows ten password sign-ins per person in fifteen minutes.
    const cookie = (setUp.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const name = cookie.slice(0, cookie.indexOf("="));
    const value = cookie.slice(cookie.indexOf("=") + 1);
    const made = await fetch(`${direct}/api/v1/w/${WORKSPACE.slug}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ name: "desktop-e2e" }),
    });
    if (!made.ok) throw new Error(`token: ${made.status} ${await made.text()}`);
    const { token } = (await made.json()) as { token: string };
    const run: Run = {
      direct,
      server: standIn ? fake.url : direct,
      other: standIn ? direct : fake.url,
      fake: fake.url,
      token,
      session: { name, value },
      dir,
      binary,
    };
    process.env.QUADIT_DESKTOP_E2E = JSON.stringify(run);
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("no port"))));
    });
  });
}

async function waitUntilUp(url: string, server: ChildProcess, log: () => string) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`quadit serve exited (${server.exitCode}):\n${log()}`);
    try {
      if ((await fetch(`${url}/readyz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error(`quadit serve did not answer on ${url} within 20 s:\n${log()}`);
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null) return;
  const exited = new Promise((done) => server.once("exit", done));
  server.kill("SIGTERM");
  const killed = setTimeout(() => server.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(killed);
}
