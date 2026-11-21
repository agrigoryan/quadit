// The first start and setup: the first start shows the first run (not
// setup, nor the server list), and not again once its window is closed;
// setup, the checklist, opens from the app menu with its steps in order.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desktop, expect, test } from "./desktop";

/** What the settings file in `data` says of the first run; undefined while the app has not written it yet. */
function savedSetupDone(data: string): boolean | undefined {
  try {
    return (JSON.parse(readFileSync(join(data, "settings.json"), "utf8")) as { setupDone?: boolean }).setupDone;
  } catch {
    return undefined;
  }
}

/** Whether one of the app's own pages, `file`, is open. */
function isOpen(desktop: Desktop, file: string): boolean {
  return desktop.app.windows().some((page) => page.url().endsWith(`/${file}`));
}

test("the first start shows the first run instead of setup, and once its window is closed the next start does not", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  let desktop = await Desktop.launch(data, run, [], { firstStart: true });
  try {
    const first = await desktop.firstRun();
    await expect(first.getByRole("heading", { level: 1, name: "Welcome to Quadit" })).toBeVisible();
    expect(isOpen(desktop, "setup.html")).toBe(false);
    expect(isOpen(desktop, "servers.html")).toBe(false);
    // Its window, the one shown, closed as a person closes it: no server took it, so it goes with the first run.
    await desktop.app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()
        .find((win) => win.isVisible())
        ?.close(),
    );
    await expect.poll(() => savedSetupDone(data)).toBe(true);
    await expect.poll(() => desktop.firstRunShown()).toBe(false);
    expect(await desktop.shownWindows()).toEqual([]);
  } finally {
    await desktop.close();
  }

  desktop = await Desktop.launch(data, run);
  try {
    await desktop.serverList();
    expect(desktop.firstRunShown()).toBe(false);
    expect(isOpen(desktop, "setup.html")).toBe(false);
  } finally {
    await desktop.close();
  }
});

test("setup opens from the app menu with its steps in order", async ({ desktop }) => {
  await desktop.chooseMenuItem("setup");
  const setup = await desktop.appPage("setup.html");
  await expect(setup.getByRole("heading", { level: 2 })).toHaveText([
    "1. Add your server",
    "2. Sign in",
    "3. Notifications",
    "4. Connect your agents",
    "5. Quick capture",
  ]);
  await expect(setup.getByRole("checkbox", { name: /quick capture/ })).toBeChecked();
  await setup.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => isOpen(desktop, "setup.html")).toBe(false);
});
