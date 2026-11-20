// The first run, as a person meets it (desktop contract §7): Welcome, a
// name, "Set up on this computer", and the workspace, signed in, with
// Connect agents over it once; or "Connect to a server", as far as it goes
// without a browser. Each step's window is saved as a picture in
// onboarding-screens/ (outside test-results, which Playwright empties at
// every run), in the order a person sees them; desktop-ci keeps the folder
// on every run as the artifact desktop-onboarding-screens.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Desktop, expect, test } from "./desktop";

const SCREENS = join(__dirname, "../../onboarding-screens");

/** Saves what `page`'s window shows as `name` in the screens folder. */
async function screen(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: join(SCREENS, name) });
}

/**
 * The quadit `binary`, started a few seconds late: the start a person
 * waits through, long enough to be seen and pictured. Its input reaches
 * the server untouched (exec), app key and all.
 */
function slowToStart(binary: string): string {
  const script = join(mkdtempSync(join(tmpdir(), "quadit-desktop-slow-")), "quadit");
  writeFileSync(script, `#!/bin/sh\nsleep 3\nexec '${binary}' "$@"\n`);
  chmodSync(script, 0o755);
  return script;
}

/** Whether one of the app's own pages, `file`, is open. */
function isOpen(desktop: Desktop, file: string): boolean {
  return desktop.app.windows().some((page) => page.url().endsWith(`/${file}`));
}

/** Closes the window showing the app's own page `file`, as a person closing it. */
async function closePage(desktop: Desktop, file: string) {
  await desktop.app.evaluate(
    ({ BrowserWindow }, wanted) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().endsWith(`/${wanted}`))
        ?.close(),
    file,
  );
  await expect.poll(() => isOpen(desktop, file)).toBe(false);
}

test("the first run sets Quadit up on this computer with a name alone, lands in the workspace signed in, and offers Connect agents once", async ({
  run,
}) => {
  // Two starts of the app, each waiting for its server.
  test.slow();
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const env = { QUADIT_DESKTOP_QUADIT: slowToStart(run.binary) };
  let desktop = await Desktop.launch(data, run, [], { env, firstStart: true });
  let origin = "";
  try {
    const welcome = await desktop.appPage("welcome.html");
    await expect(welcome.getByRole("heading", { level: 1, name: "Welcome to Quadit" })).toBeVisible();
    const name = welcome.getByLabel("Your name");
    // Offered: the name of the person's account on this computer.
    await expect(name).not.toHaveValue("");
    await expect(welcome.getByRole("button", { name: "Connect to a server" })).toBeVisible();
    expect(isOpen(desktop, "setup.html")).toBe(false);
    await screen(welcome, "01-welcome.png");

    await name.fill("Lou Local");
    await screen(welcome, "02-name.png");
    await welcome.getByRole("button", { name: "Set up on this computer" }).click();
    await expect(welcome.getByText("Starting Quadit…")).toBeVisible();
    await screen(welcome, "03-starting.png");

    origin = await desktop.localOrigin();
    const page = await desktop.pageOf(origin);
    // The workspace the app made, signed in as the name given: no form, no browser.
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(`${origin}/personal/my-work`);
    const me = (await page.evaluate(async () => (await fetch("/api/v1/auth/me")).json())) as { user: { name: string } };
    expect(me.user.name).toBe("Lou Local");
    expect((await desktop.recorded()).opened).toEqual([]);
    await expect.poll(() => isOpen(desktop, "welcome.html")).toBe(false);

    // Connect agents, over the workspace, once.
    const connect = await desktop.appPage("connect.html");
    await expect(connect.getByRole("heading", { level: 1, name: "Connect agents" })).toBeVisible();
    await screen(connect, "04-connect-agents.png");
    await closePage(desktop, "connect.html");
    await screen(page, "05-workspace.png");
  } finally {
    await desktop.close();
  }

  // Started again: the workspace again, signed in, and Connect agents does not come back by itself.
  desktop = await Desktop.launch(data, run, [], { env });
  try {
    const page = await desktop.pageOf(origin);
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
    expect(isOpen(desktop, "connect.html")).toBe(false);
    expect(isOpen(desktop, "welcome.html")).toBe(false);
  } finally {
    await desktop.close();
  }
});

test("the first run connects to a server elsewhere from Welcome, whose window offers the browser sign-in", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { env: { QUADIT_DESKTOP_QUADIT: run.binary }, firstStart: true });
  try {
    const welcome = await desktop.appPage("welcome.html");
    await welcome.getByRole("button", { name: "Connect to a server" }).click();
    await expect(welcome.getByRole("heading", { name: "Connect to a server" })).toBeVisible();
    await expect(welcome.getByRole("button", { name: "Back" })).toBeVisible();
    await welcome.getByLabel("Address").fill(run.server);
    await screen(welcome, "06-connect-to-a-server.png");
    await welcome.getByRole("button", { name: "Add server" }).click();

    const page = await desktop.pageOf(run.server);
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => isOpen(desktop, "welcome.html")).toBe(false);
    // Nothing was set up on this computer.
    expect(await desktop.app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById("set-up-here"))).toBe(
      true,
    );

    // The browser sign-in is offered over the sign-in page; the system browser takes it from there.
    const bar = await desktop.signInBar();
    await bar.getByRole("button", { name: "Sign in with your browser" }).click();
    await expect.poll(async () => (await desktop.recorded()).opened.length).toBe(1);
    const sent = new URL((await desktop.recorded()).opened[0] ?? "");
    expect(sent.origin + sent.pathname).toBe(`${run.server}/desktop/connect`);
  } finally {
    await desktop.close();
  }
});
