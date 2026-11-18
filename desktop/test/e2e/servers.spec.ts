import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rectangle } from "electron";
import { Desktop, expect, signInWithPassword, test } from "./desktop";

test("a server added by its address opens in its own window, on its own session, at its sign-in page", async ({
  desktop,
  run,
}) => {
  const list = await desktop.serverList();
  await expect(list.getByText("No servers yet.")).toBeVisible();

  const page = await desktop.addServer(run.server, "Work");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

  // Listed, with what the server answered, and that a local http server is not encrypted.
  await expect(list.getByText("Work", { exact: true })).toBeVisible();
  await expect(list.getByText(run.server)).toBeVisible();
  await expect(list.getByText(/Not encrypted \(http\), which is fine on this computer/)).toBeVisible();
  await expect(list.getByRole("button", { name: "Sign in to Work with your browser" })).toBeEnabled();

  // Its own persistent partition, and the app's name in its user agent.
  const id = desktop.serverId(run.server);
  expect(id).toMatch(/^[0-9a-f]{12}$/);
  const own = await desktop.app.evaluate(
    ({ BrowserWindow, session }, { origin, partition }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(origin));
      // Not in Electron's types, but there: the preferences the page was made with.
      const preferences = (
        win?.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences } | undefined
      )?.getLastWebPreferences();
      return {
        sameSession: win?.webContents.session === session.fromPartition(partition),
        persistent: win?.webContents.session.isPersistent(),
        sandboxed: preferences?.sandbox,
        isolated: preferences?.contextIsolation,
        node: preferences?.nodeIntegration,
      };
    },
    { origin: run.server, partition: `persist:server-${id}` },
  );
  expect(own).toEqual({ sameSession: true, persistent: true, sandboxed: true, isolated: true, node: false });
  expect(await page.evaluate(() => navigator.userAgent)).toMatch(/ QuaditDesktop\/0\.1\.0$/);
});

test("an address that is not a Quadit server is refused with the reason", async ({ desktop }) => {
  const list = await desktop.serverList();
  await list.getByLabel("Address").fill("ftp://files.example.com");
  await list.getByRole("button", { name: "Add server" }).click();
  await expect(list.getByRole("alert")).toHaveText(/That is not a web address/);

  await list.getByLabel("Address").fill("http://127.0.0.1:9");
  await list.getByRole("button", { name: "Add server" }).click();
  await expect(list.getByRole("alert")).toHaveText(/Could not reach http:\/\/127\.0\.0\.1:9/);
  await expect(list.getByText("No servers yet.")).toBeVisible();
});

test("a server over plain http elsewhere is added only when the person says so", async ({ desktop }) => {
  const list = await desktop.serverList();
  await list.getByLabel("Address").fill("http://quadit.invalid");
  await list.getByRole("button", { name: "Add server" }).click();
  await expect(list.getByRole("alert")).toHaveText(/http:\/\/quadit\.invalid is not encrypted/);
  await expect(list.getByText("No servers yet.")).toBeVisible();

  // Said so: only now is the server asked what it is (this one is nowhere).
  await list.getByRole("button", { name: "Add without encryption" }).click();
  await expect(list.getByRole("alert")).toHaveText(/Could not reach http:\/\/quadit\.invalid/);
  await expect(list.getByRole("button", { name: "Add without encryption" })).toBeHidden();

  // https needs no word.
  await list.getByLabel("Address").fill("quadit.invalid");
  await list.getByRole("button", { name: "Add server" }).click();
  await expect(list.getByRole("alert")).toHaveText(/Could not reach https:\/\/quadit\.invalid/);
});

test("an older Quadit without the hand-off is added, and says to sign in with a password", async ({ desktop, run }) => {
  // The stand-in as a Quadit from before the desktop app: it has no /api/v1/version.
  await fetch(`${run.fake}/__fake/handoff?version=0`);
  try {
    await desktop.addServer(run.fake, "Old");
    const list = await desktop.serverList();
    await expect(list.getByText(/This server is older than the app/)).toBeVisible();
    await expect(list.getByRole("button", { name: "Sign in to Old with your browser" })).toBeDisabled();
  } finally {
    await fetch(`${run.fake}/__fake/handoff?version=1`);
  }
});

test("at start the app asks each server again, says when one became too new for it, and starts no sign-in there", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  let desktop = await Desktop.launch(data, run);
  await desktop.addServer(run.fake, "Fake");
  await desktop.close();

  await fetch(`${run.fake}/__fake/handoff?version=2`);
  desktop = await Desktop.launch(data, run);
  try {
    await expect
      .poll(async () => (await desktop.recorded()).dialogs)
      .toEqual([expect.stringMatching(/^Fake needs a newer Quadit app .*Quadit e2e-fake/)]);
    // Any way to start the browser sign-in (here the server list's, which the menu's and the bar's share) is refused.
    const id = desktop.serverId(run.fake);
    await desktop.app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((item) => item.label === "File")
        ?.submenu?.items.find((item) => item.label === "Servers…")
        ?.click(),
    );
    await (await desktop.serverList()).evaluate((server) => window.quaditPages?.signIn(server), id);
    await expect.poll(async () => (await desktop.recorded()).dialogs).toHaveLength(2);
    expect((await desktop.recorded()).opened).toEqual([]);
  } finally {
    await fetch(`${run.fake}/__fake/handoff?version=1`);
    await desktop.close();
  }
});

test("the app reopens the server windows that were open, where they were, still signed in, and on screen", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  let desktop = await Desktop.launch(data, run);
  const page = await desktop.addServer(run.server);
  await signInWithPassword(page);
  /** The server's window: where it is, and whether it shows. */
  const serverWindow = () =>
    desktop.app.evaluate(({ BrowserWindow }, origin) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(origin));
      return { bounds: win?.getBounds(), visible: win?.isVisible() };
    }, run.server);
  const place = (bounds: Rectangle) =>
    desktop.app.evaluate(
      ({ BrowserWindow }, [origin, wanted]) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().startsWith(origin))
          ?.setBounds(wanted);
      },
      [run.server, bounds] as const,
    );
  const reopen = async () => {
    await desktop.close();
    desktop = await Desktop.launch(data, run);
    await expect(await desktop.pageOf(run.server)).toHaveURL(/\/e2e(\/|$)/);
  };
  // Off the centre the app would first open it at, and inside the screen, whatever its size (a hosted Mac's is small).
  const area = await desktop.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const width = Math.min(1010, area.width - 100);
  const height = Math.min(700, area.height - 80);
  const bounds = { x: area.x + 24, y: area.y + 16, width, height };
  await place(bounds);

  try {
    await reopen();
    expect(await serverWindow()).toEqual({ bounds, visible: true });
    // With a server open, the list does not show at start.
    expect(desktop.app.windows().some((p) => p.url().endsWith("servers.html"))).toBe(false);

    // Left half off the screen (the screen it was on got smaller, say), it comes back whole, against the edges it crossed.
    await place({
      x: area.x + area.width - Math.round(width / 2),
      y: area.y + area.height - Math.round(height / 2),
      width,
      height,
    });
    await reopen();
    expect(await serverWindow()).toEqual({
      bounds: { x: area.x + area.width - width, y: area.y + area.height - height, width, height },
      visible: true,
    });
  } finally {
    await desktop.close();
  }
});
