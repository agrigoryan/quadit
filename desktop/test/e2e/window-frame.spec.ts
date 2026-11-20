// The window without a title bar (desktop contract §9; src/main/window-frame.ts),
// on macOS: a server whose pages are laid out for it gets a server window with
// no title bar, whose page sees the window's controls overlay and keeps the
// buttons' corner free; a server whose pages know nothing of it keeps its
// title bar. What macOS gave the window (the title area's rect, where the
// buttons are) is written to window-frame.json in onboarding-screens/, beside
// a picture of the page and, where the runner lets screencapture record the
// screen, one of the window with its buttons, so the strip's height and the
// buttons' place can be tuned from CI's run (the artifact
// desktop-onboarding-screens).

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { type Desktop, expect, test } from "./desktop";

const SCREENS = join(__dirname, "../../onboarding-screens");

test.skip(process.platform !== "darwin", "only macOS has a window without a title bar");

/** The window of the server at `origin`, as the main process has it: its frame, its content, and its buttons' place. */
function serverWindow(desktop: Desktop, origin: string) {
  return desktop.app.evaluate(({ BrowserWindow }, wanted) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(wanted));
    if (!win) return null;
    const bar = win.contentView.children.find((view) => view.getVisible());
    return {
      bounds: win.getBounds(),
      content: win.getContentBounds(),
      buttons: win.getWindowButtonPosition(),
      // The bar over the sign-in page, when it shows.
      bar: bar?.getBounds() ?? null,
      // "window:<CGWindowID>:0": the number screencapture -l takes.
      source: win.getMediaSourceId(),
    };
  }, origin);
}

/** What the page is told of the window's controls overlay. */
function overlayOf(page: Page) {
  return page.evaluate(() => {
    const overlay = (
      navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }
    ).windowControlsOverlay;
    const rect = overlay?.getTitlebarAreaRect();
    return {
      visible: overlay?.visible ?? false,
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    };
  });
}

/** The controls of the page whose boxes meet the corner left of `left` and above `height`, by their names. */
function controlsInTheCorner(page: Page, corner: { left: number; height: number }): Promise<string[]> {
  return page.evaluate((area) => {
    const controls = document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [contenteditable], [role=button], [tabindex]:not([tabindex='-1'])",
    );
    return [...controls]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        const shown = box.width > 0 && box.height > 0 && getComputedStyle(el).visibility === "visible";
        return shown && box.left < area.left && box.top < area.height;
      })
      .map((el) => el.getAttribute("aria-label") || el.textContent?.trim() || el.tagName);
  }, corner);
}

test("a server whose pages are laid out for it opens in a window without a title bar, its buttons over a corner the page keeps free", async ({
  desktop,
  run,
}) => {
  // The server built from this tree says inset 1 in its version answer.
  const signIn = await desktop.addServer(run.direct);
  await expect(signIn).toHaveURL(/\/login/);
  await expect(signIn.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect.poll(async () => (await serverWindow(desktop, run.direct))?.bar).not.toBeNull();
  const atSignIn = await serverWindow(desktop, run.direct);
  const signInOverlay = await overlayOf(signIn);

  const page = await desktop.signedIn(run.direct);
  const win = await serverWindow(desktop, run.direct);
  const overlay = await overlayOf(page);

  // What macOS gave, for tuning the strip (src/main/window-frame.ts) whatever the checks below say.
  mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: join(SCREENS, "window-frame-page.png") });
  const picture = await captureWindow(win?.source ?? "", join(SCREENS, "window-frame-window.png"));
  const measured = { window: win, overlay, signIn: { bar: atSignIn?.bar, overlay: signInOverlay }, picture };
  writeFileSync(join(SCREENS, "window-frame.json"), JSON.stringify(measured, null, 2));

  // No title bar: the page fills the window to its top edge.
  expect(win?.content.height).toBe(win?.bounds.height);
  // The page sees the overlay, its title area starting past the buttons: Electron makes it the buttons with the
  // window's button position as a margin on every side.
  const buttons = win?.buttons ?? { x: 0, y: 0 };
  expect(overlay.visible).toBe(true);
  expect(overlay.rect?.x).toBeGreaterThan(2 * buttons.x);
  expect(overlay.rect?.height).toBeGreaterThan(2 * buttons.y);
  await expect(page.locator("html")).toHaveAttribute("data-window-inset", "");
  const corner = { left: overlay.rect?.x ?? 0, height: overlay.rect?.height ?? 0 };
  await expect.poll(() => controlsInTheCorner(page, corner)).toEqual([]);
  // The bar over the sign-in page sat under the buttons, not over them.
  expect(atSignIn?.bar?.y).toBeGreaterThanOrEqual(corner.height - buttons.y);
});

test("a server whose pages know nothing of a window without a title bar keeps its title bar", async ({
  desktop,
  run,
}) => {
  // The hand-off stand-in answers its version without inset, as a server from before it does.
  const page = await desktop.addServer(run.fake);
  await expect(page).toHaveURL(/\/login/);
  const win = await serverWindow(desktop, run.fake);
  expect(win?.content.height).toBeLessThan(win?.bounds.height ?? 0);
  expect((await overlayOf(page)).visible).toBe(false);
  await expect(page.locator("html")).not.toHaveAttribute("data-window-inset");
});

/**
 * Takes a picture of the window, its buttons in it, with macOS's screencapture, and says how that went. A hosted
 * runner may not let the app record the screen: then there is no picture, which fails nothing.
 */
async function captureWindow(source: string, path: string): Promise<string> {
  const id = /^window:(\d+):/.exec(source)?.[1];
  if (!id) return `no window number in ${JSON.stringify(source)}`;
  try {
    await promisify(execFile)("screencapture", ["-x", "-o", "-l", id, path]);
    return `taken: ${path}`;
  } catch (err) {
    return `screencapture refused: ${err instanceof Error ? err.message : String(err)}`;
  }
}
