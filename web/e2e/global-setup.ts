// Starts one Quadit server for the whole run: the binary `make build` made,
// on a free port, with a new empty data directory. It walks the first-run
// page once to make the owner and the workspace, keeps that signed-in
// browser state for the tests, makes an agent and an API token for each of
// them, and hands all of it to the tests through QUADIT_E2E (see
// e2e/quadit.ts). The function it returns stops the server, leaves its log
// beside the test results and removes the directory.

import { join, resolve } from "node:path";
import { chromium, expect, type FullConfig } from "@playwright/test";
import { AGENT, fromOwnPage, OWNER, quadit, type Run, WORKSPACE } from "./run";
import { startServer } from "./server";

export default async function globalSetup(config: FullConfig) {
  const server = await startServer();
  const stop = () => server.stop(config.projects[0]?.outputDir ?? server.dir);
  try {
    const run = await firstRun(server.url, server.dir, config.projects[0]?.use.headless ?? true);
    process.env.QUADIT_E2E = JSON.stringify(run);
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
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
