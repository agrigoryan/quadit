// Running Quadit on this computer: the app runs the quadit the run built
// (QUADIT_DESKTOP_QUADIT, standing in for the one the packaged app
// carries), on a data folder in its own, opens the server's first-run page
// in a window, where the owner is made and signed in without the browser,
// and stops the server when it quits.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desktop, expect, test } from "./desktop";

/** The port the app chose for its server, from its settings file; 0 until it has. */
function chosenPort(data: string): number {
  try {
    return (JSON.parse(readFileSync(join(data, "settings.json"), "utf8")) as { localPort?: number }).localPort ?? 0;
  } catch {
    return 0;
  }
}

/** Whether a Quadit server answers at `origin`. */
async function answers(origin: string): Promise<boolean> {
  try {
    return (await fetch(`${origin}/readyz`)).ok;
  } catch {
    return false;
  }
}

test("running Quadit on this computer starts a server whose first-run page signs its owner in, in the window; quitting stops it", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { env: { QUADIT_DESKTOP_QUADIT: run.binary }, firstStart: true });
  let origin = "";
  try {
    const setup = await desktop.appPage("setup.html");
    await setup.getByRole("button", { name: "Run Quadit on this computer" }).click();
    await expect.poll(() => chosenPort(data)).toBeGreaterThan(0);
    origin = `http://127.0.0.1:${chosenPort(data)}`;

    const page = await desktop.pageOf(origin, "/setup");
    expect(await answers(origin)).toBe(true);
    expect(existsSync(join(data, "server", "quadit.sqlite"))).toBe(true);
    await page.getByLabel("Your name").fill("Lou Local");
    await page.getByLabel("Email").fill("lou@example.com");
    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
    await page.getByLabel("Workspace name").fill("Mine");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(new RegExp(`^${origin}/mine(/|$)`));
    // Signed in in the window itself: no browser was asked.
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
    expect((await desktop.recorded()).opened).toEqual([]);

    // The list shows it as this computer's, running, with its controls; so does the menu.
    await desktop.chooseMenuItem("servers");
    const list = await desktop.serverList();
    await expect(list.getByText("This computer", { exact: true })).toBeVisible();
    await expect(list.getByText("Running on this computer while the app is open")).toBeVisible();
    await expect(list.getByRole("button", { name: "Stop the server on this computer" })).toBeEnabled();
    expect(
      await desktop.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("local-stop")?.enabled),
    ).toBe(true);
  } finally {
    await desktop.close();
  }
  // Quitting the app stopped its server.
  expect(origin).not.toBe("");
  expect(await answers(origin)).toBe(false);
});

test("without a server to run, the choice says so in a sentence", async ({ run }) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { firstStart: true });
  try {
    const setup = await desktop.appPage("setup.html");
    await expect(setup.getByText("Not available in this copy of the app")).toBeVisible();
    await expect(setup.getByRole("button", { name: "Run Quadit on this computer" })).toHaveCount(0);
  } finally {
    await desktop.close();
  }
});
