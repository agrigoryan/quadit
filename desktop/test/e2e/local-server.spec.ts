// Quadit on this computer: the app runs the quadit the run built
// (QUADIT_DESKTOP_QUADIT, standing in for the one the packaged app
// carries) on a data folder in its own, makes its owner itself and signs
// its window in without a form whenever it has no session there, and has
// the server stop when it quits. The first run's own way there is
// onboarding.spec.ts.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Desktop, expect, test } from "./desktop";

/** Whether a Quadit server answers at `origin`. */
async function answers(origin: string): Promise<boolean> {
  try {
    return (await fetch(`${origin}/readyz`)).ok;
  } catch {
    return false;
  }
}

/** Sets Quadit up on this computer from the server list, through Welcome, and gives the server's address and its window on the workspace. */
async function setUpFromTheList(desktop: Desktop): Promise<{ origin: string; page: Page }> {
  const list = await desktop.serverList();
  await list.getByRole("button", { name: "Set up on this computer…" }).click();
  const welcome = await desktop.appPage("welcome.html");
  await welcome.getByLabel("Your name").fill("Lou Local");
  await welcome.getByRole("button", { name: "Set up on this computer" }).click();
  const origin = await desktop.localOrigin();
  const page = await desktop.pageOf(origin);
  await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
  return { origin, page };
}

test("set up on this computer, the app runs a server whose owner it made, shows it as this computer's, and quitting stops it", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { env: { QUADIT_DESKTOP_QUADIT: run.binary } });
  let origin = "";
  try {
    let page: Page;
    ({ origin, page } = await setUpFromTheList(desktop));
    expect(await answers(origin)).toBe(true);
    expect(existsSync(join(data, "server", "quadit.sqlite"))).toBe(true);
    await expect(page).toHaveURL(`${origin}/personal/my-work`);
    // Signed in in the window itself: no browser was asked.
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
    expect((await desktop.recorded()).opened).toEqual([]);

    // The list shows it as this computer's, running, with its controls; so does the menu.
    await desktop.chooseMenuItem("servers");
    const list = await desktop.serverList();
    await expect(list.getByText("This computer", { exact: true })).toBeVisible();
    await expect(list.getByText("Running on this computer while the app is open")).toBeVisible();
    await expect(list.getByRole("button", { name: "Stop the server on this computer" })).toBeEnabled();
    await expect(list.getByRole("button", { name: "Set up on this computer…" })).toHaveCount(0);
    expect(
      await desktop.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("local-stop")?.enabled),
    ).toBe(true);
    expect(await desktop.app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById("set-up-here"))).toBe(
      false,
    );
  } finally {
    await desktop.close();
  }
  // Quitting the app told its server to stop, which it does on its own, a moment later.
  expect(origin).not.toBe("");
  await expect.poll(() => answers(origin), { timeout: 15_000 }).toBe(false);
});

test("the window of the server on this computer is signed in by the app whenever it has no session: before it loads, and on the sign-in page", async ({
  run,
}) => {
  // Three starts of the app, two of them waiting for its server.
  test.slow();
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const env = { QUADIT_DESKTOP_QUADIT: run.binary };
  let desktop = await Desktop.launch(data, run, [], { env });
  let origin = "";
  try {
    let page: Page;
    ({ origin, page } = await setUpFromTheList(desktop));
    // Signed out (the session ran out, or the person signed out): on the sign-in page, the app signs in again
    // and goes on to the page the sign-in page was to lead to.
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/logout", { method: "POST" })).ok)).toBe(true);
    await page.evaluate(() => setTimeout(() => location.assign("/login?next=%2Fpersonal%2Finbox"), 0));
    await expect(page).toHaveURL(`${origin}/personal/inbox`, { timeout: 20_000 });
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
  } finally {
    await desktop.close();
  }

  // Started without its server (none to run), the app loads nothing there: its window's cookies are let go here.
  const id = desktop.serverId(origin);
  desktop = await Desktop.launch(data, run);
  try {
    await desktop.app.evaluate(async ({ session }, partition) => {
      const own = session.fromPartition(partition);
      await own.clearStorageData({ storages: ["cookies"] });
      await own.cookies.flushStore();
    }, `persist:server-${id}`);
  } finally {
    await desktop.close();
  }

  // With its server again, the window has no session: the app signs it in before the workspace loads.
  desktop = await Desktop.launch(data, run, [], { env });
  try {
    const page = await desktop.pageOf(origin);
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
    expect((await desktop.recorded()).opened).toEqual([]);
  } finally {
    await desktop.close();
  }
});

test("without a server to run, Welcome offers only connecting to one, and setup says why in a sentence", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { firstStart: true });
  try {
    const welcome = await desktop.appPage("welcome.html");
    await expect(welcome.getByRole("heading", { name: "Connect to a server" })).toBeVisible();
    await expect(welcome.getByLabel("Address")).toBeVisible();
    await expect(welcome.getByRole("button", { name: "Set up on this computer" })).toHaveCount(0);
    await expect(welcome.getByLabel("Your name")).toBeHidden();
    await expect(welcome.getByRole("button", { name: "Back" })).toBeHidden();

    await desktop.chooseMenuItem("setup");
    const setup = await desktop.appPage("setup.html");
    await expect(setup.getByText("Not available in this copy of the app")).toBeVisible();
    await expect(setup.getByRole("button", { name: "Set up on this computer…" })).toHaveCount(0);
  } finally {
    await desktop.close();
  }
});
