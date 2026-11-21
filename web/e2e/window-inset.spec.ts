// The pages in a window of the Quadit app without a title bar (desktop
// contract §9; src/lib/window-inset.ts): the window's buttons float over
// the page's top left corner, the page keeps that corner free and is dragged
// by its top bars. A headless browser has no such window: an init script
// plays the overlay the app's window gives the page, with a title area like
// the real one. With QUADIT_E2E_WINDOW_SHOTS naming a folder, the test also
// saves pictures of each state there, with the three buttons drawn in where
// the window would have them, for a person to look at before a build.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { currentRun } from "./run";
import { expect, test } from "./quadit";

/**
 * The title area the app's window gives the page (desktop/src/main/window-frame.ts): the buttons 16px from the left,
 * centred in a 44px strip, and the area left free past them. Electron's numbers on a real window come from the
 * desktop suite's macOS run; these are the app's intended ones.
 */
const AREA = { left: 86, height: 44 };
/** The three buttons as the pictures draw them, near enough to macOS's: 12px dots 20px apart, centred in the strip. */
const BUTTONS = { x: 16, size: 12, step: 20, colours: ["#ff5f57", "#febc2e", "#28c840"] };

const DESKTOP = { width: 1280, height: 860 };
const NARROW = { width: 600, height: 860 };

/** Plays the app's window on the page: its controls overlay, visible, with the title area above. */
async function inAppWindow(page: Page) {
  await page.addInitScript((area) => {
    const overlay = Object.assign(new EventTarget(), {
      visible: true,
      getTitlebarAreaRect: () => new DOMRect(area.left, 0, window.innerWidth - area.left, area.height),
    });
    Object.defineProperty(Navigator.prototype, "windowControlsOverlay", { get: () => overlay, configurable: true });
  }, AREA);
}

/** The controls on the page whose boxes meet the corner the window's buttons are in, by their names. */
function controlsInTheCorner(page: Page): Promise<string[]> {
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
  }, AREA);
}

/**
 * What the window is dragged by: each element that drags it while its parent does not, by its tag and label; and
 * the controls inside those that would drag it too (none should: they would take no clicks).
 */
function dragged(page: Page): Promise<{ bars: string[]; stuck: string[] }> {
  return page.evaluate(() => {
    const drags = (el: Element | null) => !!el && getComputedStyle(el).getPropertyValue("app-region") === "drag";
    // An element not drawn (display: none, or inside one) drags nothing, whatever its style says.
    const all = [...document.querySelectorAll("*")].filter((el) => el.getClientRects().length > 0);
    const bars = all.filter((el) => drags(el) && !drags(el.parentElement));
    const stuck = all.filter((el) => drags(el) && el.matches("a[href], button, input, select, textarea, [tabindex]"));
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.hasAttribute("data-window-strip") ? " strip" : ""}`;
    return { bars: bars.map(name), stuck: stuck.map((el) => el.getAttribute("aria-label") || el.tagName) };
  });
}

/** Saves the page as `name` in the pictures folder, when there is one, with the window's buttons drawn in. */
async function picture(page: Page, name: string) {
  const folder = process.env.QUADIT_E2E_WINDOW_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  // Out of the way: no hover, no tooltip.
  await page.mouse.move(page.viewportSize()?.width ?? 0, page.viewportSize()?.height ?? 0);
  await page.evaluate(
    ({ height, buttons }) => {
      const drawn = document.createElement("div");
      drawn.id = "window-buttons";
      drawn.style.cssText = "position:fixed;inset:0 auto auto 0;z-index:2147483647;pointer-events:none";
      buttons.colours.forEach((colour, i) => {
        const dot = document.createElement("span");
        const x = buttons.x + 1 + i * buttons.step;
        const y = (height - buttons.size) / 2;
        dot.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${buttons.size}px;height:${buttons.size}px;border-radius:50%;background:${colour}`;
        drawn.append(dot);
      });
      document.body.append(drawn);
    },
    { height: AREA.height, buttons: BUTTONS },
  );
  await page.screenshot({ path: join(folder, name) });
  await page.evaluate(() => document.getElementById("window-buttons")?.remove());
}

// The sidebar folds at once, so what is measured and pictured is where it ends up.
test.use({ viewport: DESKTOP, reducedMotion: "reduce" });

test("in the app's window without a title bar the workspace keeps the buttons' corner free and is dragged by its bars", async ({
  page,
}) => {
  await inAppWindow(page);
  await page.goto("/e2e/my-work");
  await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-window-inset", "");

  // The sidebar open: its strip holds the buttons and the toggle, the workspace's name below.
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  const switcher = page.getByRole("button", { name: "Switch workspace" });
  await expect(collapse).toBeVisible();
  await expect.poll(async () => (await collapse.boundingBox())?.x).toBeGreaterThanOrEqual(AREA.left);
  await expect.poll(async () => (await switcher.boundingBox())?.y).toBeGreaterThanOrEqual(AREA.height);
  await expect.poll(() => controlsInTheCorner(page)).toEqual([]);
  await expect.poll(() => dragged(page)).toEqual({ bars: ["div", "header"], stuck: [] });
  await switcher.click();
  await expect(page.getByRole("menuitem", { name: "E2E" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await picture(page, "1-sidebar-open.png");

  // Folded: the top bar leaves the buttons their space and takes the toggle after it.
  await collapse.click();
  const expand = page.getByRole("banner").getByRole("button", { name: "Expand sidebar" });
  await expect(expand).toBeVisible();
  await expect.poll(async () => (await expand.boundingBox())?.x).toBeGreaterThanOrEqual(AREA.left);
  await expect.poll(() => controlsInTheCorner(page)).toEqual([]);
  await expect.poll(() => dragged(page)).toEqual({ bars: ["div", "header"], stuck: [] });
  await picture(page, "2-sidebar-collapsed.png");
  await expand.click();
  await expect(collapse).toBeVisible();

  // Narrow, where the sidebar is a drawer: the top bar leaves the same space, and so does the drawer.
  await page.setViewportSize(NARROW);
  const open = page.getByRole("button", { name: "Open navigation" });
  await expect(open).toBeVisible();
  await expect.poll(() => controlsInTheCorner(page)).toEqual([]);
  await expect.poll(() => dragged(page)).toEqual({ bars: ["header"], stuck: [] });
  await picture(page, "3-narrow.png");
  await open.click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect.poll(() => controlsInTheCorner(page)).toEqual([]);
  await page.keyboard.press("Escape");
});

test("in the app's window without a title bar a page outside the workspace is dragged by a strip across its top", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: currentRun().url,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
    viewport: DESKTOP,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await inAppWindow(page);
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect.poll(() => controlsInTheCorner(page)).toEqual([]);
  await expect.poll(() => dragged(page)).toEqual({ bars: ["div strip"], stuck: [] });
  await picture(page, "4-sign-in.png");
  await context.close();
});

test("in a browser the page knows nothing of a window's buttons", async ({ page }) => {
  await page.goto("/e2e/my-work");
  await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-window-inset");
  await expect.poll(() => dragged(page)).toEqual({ bars: [], stuck: [] });
});
