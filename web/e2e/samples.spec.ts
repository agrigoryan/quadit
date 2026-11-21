// The sample tasks a new install starts with (desktop contract §10): the
// set-up form opens on them, a note says what they are for and which one
// an agent was given, one click removes them, and the empty workspace then
// offers them again. Setting an install up happens once per server, so
// these tests run on a server of their own. With QUADIT_E2E_SAMPLES_SHOTS
// naming a folder, they also save pictures of the note and of the empty
// workspace there, for a person to look at.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { fromOwnPage, OWNER, WORKSPACE } from "./run";
import { type Server, startServer } from "./server";

let server: Server;
let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 860 } });

test.beforeAll(async ({ browser }) => {
  server = await startServer();
  context = await browser.newContext({ baseURL: server.url, serviceWorkers: "block", colorScheme: "dark" });
  page = await context.newPage();
});

test.afterAll(async ({}, testInfo) => {
  await context?.close();
  await server?.stop(testInfo.outputDir);
});

/** Saves the page as `name` in the pictures folder, when there is one. */
async function picture(name: string) {
  const folder = process.env.QUADIT_E2E_SAMPLES_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  // Out of the way: no hover, no tooltip.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(folder, name) });
}

const note = () => page.getByRole("region", { name: "Sample tasks" });

test("a new install opens on its sample tasks, and an agent connected later is given the third", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByLabel("Workspace name").fill(WORKSPACE.name);
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page).toHaveURL(`/${WORKSPACE.slug}/p/GS/tasks`);
  await expect(note()).toContainText("Three sample tasks to try Quadit with.");
  await expect(note()).not.toContainText("is for");
  for (const [key, title] of [
    ["GS-1", "Open this task and leave a comment"],
    ["GS-2", "Write a page in Docs about what you are working on"],
    ["GS-3", "Say hello and tell Ann what you can do"],
  ] as const) {
    await expect(page.getByRole("link", { name: `Open ${key}` })).toContainText(title);
  }

  // What the desktop app does at the end of its first run, through the page: the tool connected becomes an
  // agent, and the samples' third task is handed to it.
  const made = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/changes`, {
    data: { id: randomUUID(), type: "agent.create", args: { name: "Claude Code", handle: "claude-code" } },
    headers: fromOwnPage(server.url),
  });
  expect(made.ok()).toBe(true);
  const { results } = (await made.json()) as { results: { ref: string }[] };
  const given = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/samples`, {
    data: { agent: results[0]?.ref },
    headers: fromOwnPage(server.url),
  });
  expect(given.status()).toBe(200);
  await expect(note()).toContainText(
    "GS-3 is for Claude Code: in Claude Code, ask what is on your Quadit list, and watch it report back here.",
  );
  await picture("samples-note.png");
});

test("removing them leaves the empty workspace, which offers them again", async () => {
  await note().getByRole("button", { name: "Remove sample tasks" }).click();
  await expect(page).toHaveURL(new RegExp(`/${WORKSPACE.slug}(/my-work)?$`));
  const banner = page.getByRole("region", { name: "Create your first project" });
  await expect(banner).toBeVisible();
  await picture("empty-workspace.png");

  await page.getByRole("button", { name: "Try it with sample tasks" }).click();
  // GS is the removed samples' key still, in the trash.
  await expect(page).toHaveURL(`/${WORKSPACE.slug}/p/GS2/tasks`);
  await expect(note()).toContainText("Three sample tasks to try Quadit with.");
  await expect(page.getByRole("link", { name: "Open GS2-1" })).toContainText("Open this task and leave a comment");
});
