import type { Page } from "@playwright/test";
import { type Desktop, expect, test } from "./desktop";
import { quadit } from "./run";

/**
 * Presses a key in a server's window through Electron's input path
 * (webContents.sendInputEvent), as the window gives it to the page. On
 * macOS a real key with Cmd also reaches the page before the menu (Chromium
 * sends key equivalents to the page first and gives the menu only those the
 * page leaves alone); a test cannot make real system key presses without
 * the Accessibility permission, so menu.test.ts checks instead that no
 * menu item takes the page's keys.
 */
async function press(desktop: Desktop, origin: string, keyCode: string, modifiers: string[]) {
  await desktop.app.evaluate(
    ({ BrowserWindow }, key) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(key.origin));
      win?.focus();
      win?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: key.keyCode,
        modifiers: key.modifiers as Electron.InputEvent["modifiers"],
      });
      win?.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: key.keyCode,
        modifiers: key.modifiers as Electron.InputEvent["modifiers"],
      });
    },
    { origin, keyCode, modifiers },
  );
}

const MOD = process.platform === "darwin" ? "meta" : "control";

async function tasksPage(desktop: Desktop, origin: string): Promise<{ page: Page; project: string }> {
  const project = `K${Date.now().toString(36).toUpperCase().slice(-5)}`;
  await quadit(desktop.run, ["do", "project.create", JSON.stringify({ key: project, name: `Keys ${project}` })]);
  await quadit(desktop.run, ["new", project, "First"]);
  await quadit(desktop.run, ["new", project, "Second"]);
  await desktop.addServer(origin);
  const page = await desktop.signedIn(origin);
  await page.goto(`${origin}/e2e/p/${project}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${project}-2` })).toBeVisible();
  return { page, project };
}

test("Cmd+K reaches the page and opens the command palette", async ({ desktop, run }) => {
  const { page } = await tasksPage(desktop, run.server);
  await press(desktop, run.server, "K", [MOD]);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox", { name: "Command palette" })).toBeFocused();
});

test("Cmd+A in a list reaches the page and selects its tasks", async ({ desktop, run }) => {
  const { page } = await tasksPage(desktop, run.server);
  await press(desktop, run.server, "A", [MOD]);
  await expect(page.getByText("2 selected")).toBeVisible();
  // Not the Edit menu's Select All, which selects the page's text.
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("Cmd+[ and Cmd+] go back and forward in the web app, not in the menu", async ({ desktop, run }) => {
  const { page, project } = await tasksPage(desktop, run.server);
  await page.getByRole("link", { name: `Open ${project}-1` }).click();
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${project}-1`));
  await press(desktop, run.server, "[", [MOD]);
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project}/tasks`));
  await press(desktop, run.server, "]", [MOD]);
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${project}-1`));
});
