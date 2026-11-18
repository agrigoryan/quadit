// A Quadit server of its own: the binary `make build` made, on a free port,
// with a new empty data directory. The global set-up starts the one the
// whole run shares; a test that changes the install as a whole (a setting
// every sign-in is held to) starts one for itself.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARY } from "./run";

export interface Server {
  /** Where it answers: http://HOST:PORT. */
  url: string;
  /** Its temporary directory: the data, and room for a run's files. */
  dir: string;
  /** Stops it, leaves its log in logDir when one is given, and removes the directory. */
  stop(logDir?: string): Promise<void>;
}

/**
 * Starts a server and waits until it answers. host is the name it is reached
 * by: 127.0.0.1, or localhost where passkeys are used, which need a name.
 */
export async function startServer(host: "127.0.0.1" | "localhost" = "127.0.0.1"): Promise<Server> {
  if (!existsSync(BINARY)) {
    throw new Error(`No Quadit binary at ${BINARY}. Build it first: make build (or run the suite with make e2e).`);
  }
  const dir = await mkdtemp(join(tmpdir(), "quadit-e2e-"));
  const port = await freePort();
  const url = `http://${host}:${port}`;
  const server = spawn(BINARY, ["serve", "--listen", `127.0.0.1:${port}`, "--data", join(dir, "data"), "--url", url], {
    stdio: ["ignore", "ignore", "pipe"],
    // Nothing from the shell that started the run may point it elsewhere.
    env: { PATH: process.env.PATH ?? "", HOME: dir, QUADIT_CONFIG: join(dir, "cli.json") },
  });
  let log = "";
  server.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const stop = async (logDir?: string) => {
    await stopServer(server);
    if (logDir) {
      // Beside the traces, for a failure that started on the server.
      await mkdir(logDir, { recursive: true });
      await writeFile(join(logDir, "quadit-server.log"), log);
    }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitUntilUp(url, server, () => log);
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, dir, stop };
}

/** A port nothing listens on now. */
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
