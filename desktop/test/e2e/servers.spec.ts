import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // The real server's own address: until the server side lands, it has no /api/v1/version.
  const version = await fetch(`${run.direct}/api/v1/version`);
  test.skip(version.ok, "the server speaks the hand-off already");
  await desktop.addServer(run.direct, "Old");
  const list = await desktop.serverList();
  await expect(list.getByText(/This server is older than the app/)).toBeVisible();
  await expect(list.getByRole("button", { name: "Sign in to Old with your browser" })).toBeDisabled();
});

test("the app reopens the server windows that were open, where they were, still signed in", async ({ run }) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  let desktop = await Desktop.launch(data, run);
  const page = await desktop.addServer(run.server);
  await signInWithPassword(page);
  const bounds = { x: 140, y: 120, width: 1010, height: 700 };
  await desktop.app.evaluate(({ BrowserWindow }, wanted) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() !== "Quadit Servers" && w.isVisible())
      ?.setBounds(wanted);
  }, bounds);
  await desktop.close();

  desktop = await Desktop.launch(data, run);
  try {
    const again = await desktop.pageOf(run.server);
    await expect(again).toHaveURL(/\/e2e(\/|$)/);
    const restored = await desktop.app.evaluate(({ BrowserWindow }, origin) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(origin));
      return { bounds: win?.getBounds(), visible: win?.isVisible() };
    }, run.server);
    expect(restored).toEqual({ bounds, visible: true });
    // With a server open, the list does not show at start.
    expect(desktop.app.windows().some((p) => p.url().endsWith("servers.html"))).toBe(false);
  } finally {
    await desktop.close();
  }
});
