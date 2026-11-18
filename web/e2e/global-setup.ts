// Starts one Quadit server for the whole run: the binary `make build` made,
// on a free port, with a new empty data directory. It walks the first-run
// page once to make the owner and the workspace, keeps that signed-in
// browser state for the tests, makes an agent and an API token for each of
// them, and hands all of it to the tests through QUADIT_E2E (see
// e2e/quadit.ts). The function it returns stops the server, leaves its log
// beside the test results and removes the directory.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type FullConfig } from "@playwright/test";
import { AGENT, BINARY, fromOwnPage, OWNER, quadit, type Run, WORKSPACE } from "./run";

export default async function globalSetup(config: FullConfig) {
  if (!existsSync(BINARY)) {
    throw new Error(`No Quadit binary at ${BINARY}. Build it first: make build (or run the suite with make e2e).`);
  }
  const dir = await mkdtemp(join(tmpdir(), "quadit-e2e-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(BINARY, ["serve", "--listen", `127.0.0.1:${port}`, "--data", join(dir, "data"), "--url", url], {
    stdio: ["ignore", "ignore", "pipe"],
    // Nothing from the shell that started the run may point it elsewhere.
    env: { PATH: process.env.PATH ?? "", HOME: dir, QUADIT_CONFIG: join(dir, "cli.json") },
  });
  let log = "";
  server.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const stop = async () => {
    await stopServer(server);
    // Beside the traces, for a failure that started on the server.
    await mkdir(config.projects[0]?.outputDir ?? dir, { recursive: true });
    await writeFile(join(config.projects[0]?.outputDir ?? dir, "quadit-server.log"), log);
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitUntilUp(url, server, () => log);
    const run = await firstRun(url, dir, config.projects[0]?.use.headless ?? true);
    process.env.QUADIT_E2E = JSON.stringify(run);
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
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

/** The set-up page as a new owner sees it, then a token for the CLI, and an agent with one of its own. */
async function firstRun(url: string, dir: string, headless: boolean): Promise<Run> {
  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage({ baseURL: url });
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel("Your name").fill(OWNER.name);
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByLabel("Workspace name").fill(WORKSPACE.name);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(new RegExp(`/${WORKSPACE.slug}(/|$)`));
    const storageState = join(dir, "owner.json");
    await page.context().storageState({ path: storageState });
    const made = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/tokens`, {
      data: { name: "e2e" },
      headers: fromOwnPage(url),
    });
    if (!made.ok()) throw new Error(`token: ${made.status()} ${await made.text()}`);
    const { token } = (await made.json()) as { token: string };
    const run = { url, dir: resolve(dir) };
    await quadit(run, token, ["do", "agent.create", JSON.stringify(AGENT)]);
    const agentMade = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/tokens`, {
      data: { name: "e2e", user: `@${AGENT.handle}` },
      headers: fromOwnPage(url),
    });
    if (!agentMade.ok()) throw new Error(`agent token: ${agentMade.status()} ${await agentMade.text()}`);
    const { token: agentToken } = (await agentMade.json()) as { token: string };
    return { ...run, token, agentToken, storageState };
  } finally {
    await browser.close();
  }
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null) return;
  const exited = new Promise((done) => server.once("exit", done));
  server.kill("SIGTERM");
  const killed = setTimeout(() => server.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(killed);
}
