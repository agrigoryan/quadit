// The demo server the website's pictures are taken of, shared by capture.ts
// (the screenshots) and video.ts (the hero video): the binary `make build`
// made, started on a free port with a new, empty data directory (as
// web/e2e/global-setup.ts does), filled by seed.sh, and a browser signed in
// as the demo workspace's owner in the dark theme at twice the pixels.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser, BrowserContext } from "@playwright/test";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "../..");
export const QUADIT = join(root, "bin/quadit");
// Playwright comes from the web app's own dependencies (web/node_modules).
const require = createRequire(join(root, "web/package.json"));
export const { chromium } = require("@playwright/test") as typeof import("@playwright/test");

export const WS = "harbor-studio";
export const OWNER = { email: "maya@harbor.example", password: "correct-horse-battery" };
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };

/**
 * A new server with the demo workspace in it, and how to stop it. Stopping
 * also removes its data directory. `dir` is a scratch folder that goes with it.
 */
export async function startAndSeed() {
  const dir = await mkdtemp(join(tmpdir(), "quadit-shots-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(QUADIT, ["serve", "--listen", `127.0.0.1:${port}`, "--data", join(dir, "data"), "--url", url], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { PATH: process.env.PATH ?? "", HOME: dir, QUADIT_CONFIG: join(dir, "cli.json") },
  });
  const stop = async () => {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitUntilUp(url);
    await promisify(execFile)("bash", [join(here, "seed.sh")], {
      cwd: root,
      env: { ...process.env, QUADIT_SEED_URL: url, QUADIT_BIN: QUADIT, HOME: dir },
    });
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, dir, stop };
}

/** A browser signed in as the owner, in the dark theme, at twice the pixels. */
export async function signedIn(
  browser: Browser,
  url: string,
  { phone = false, motion = false }: { phone?: boolean; motion?: boolean } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: url,
    viewport: phone ? PHONE : DESKTOP,
    deviceScaleFactor: 2,
    colorScheme: "dark",
    // Stills are taken without the app's transitions; a video wants them.
    reducedMotion: motion ? "no-preference" : "reduce",
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(() => localStorage.setItem("quadit.theme", "dark"));
  const res = await context.request.post("/api/v1/auth/login", { data: OWNER });
  if (!res.ok()) throw new Error(`sign-in: ${res.status()} ${await res.text()}`);
  return context;
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

async function waitUntilUp(url: string) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${url}/readyz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error(`quadit serve did not answer on ${url} within 20 s`);
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null) return;
  const exited = new Promise((done) => server.once("exit", done));
  server.kill("SIGTERM");
  await exited;
}
