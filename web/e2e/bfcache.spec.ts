// Back and Forward with the browser's back/forward cache on (the
// "chromium-bfcache" project in playwright.config.ts): the page is kept
// whole while the person is elsewhere and shown again as it was. Put away,
// a tab of the app lets go of the live stream and of the lead among the
// tabs; shown again, it must catch up and follow the stream again
// (data/sync.ts, data/tab-share.ts).

import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./quadit";

/** Notes, in every document the page loads from now on, whether it was last shown from the cache. */
async function notePageshow(page: Page) {
  await page.addInitScript(() => {
    addEventListener("pageshow", (e) => {
      document.documentElement.dataset.restored = String(e.persisted);
    });
  });
}

/**
 * Goes to another document, does `meanwhile`, and comes back with Back.
 * Fails, with Chrome's reasons, unless the page came back from the cache.
 */
async function awayAndBack(page: Page, meanwhile: () => Promise<unknown> = async () => {}) {
  await page.evaluate(() => delete document.documentElement.dataset.restored);
  await page.goto("/readyz");
  await meanwhile();
  // A page shown from the cache fires no "load".
  await page.goBack({ waitUntil: "commit" });
  await expect(page.locator("html")).toHaveAttribute("data-restored", /./);
  const restored = await page.evaluate(() => document.documentElement.dataset.restored === "true");
  const reasons = await page.evaluate(() =>
    JSON.stringify(
      (performance.getEntriesByType("navigation")[0] as unknown as { notRestoredReasons?: unknown })
        ?.notRestoredReasons,
    ),
  );
  expect(restored, `not restored from the back/forward cache: ${reasons}`).toBe(true);
}

/** The live streams the context's pages hold open now. Exactly one means exactly one tab leads. */
function openStreams(context: BrowserContext) {
  const open = new Set<unknown>();
  context.on("request", (r) => {
    if (r.url().includes("/events/stream")) open.add(r);
  });
  context.on("requestfinished", (r) => open.delete(r));
  context.on("requestfailed", (r) => open.delete(r));
  return () => open.size;
}

test("a page shown again from the cache shows what changed meanwhile and follows the stream again", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Draft the agenda");
  await notePageshow(page);
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const row = page.getByRole("link", { name: `Open ${key}` });
  await expect(row).toHaveText("Draft the agenda");

  await awayAndBack(page, () => quadit.agent("update", key, "title=Draft the agenda for Monday"));
  await expect(row).toHaveText("Draft the agenda for Monday");

  await quadit.agent("update", key, "title=Draft the agenda for Tuesday");
  await expect(row).toHaveText("Draft the agenda for Tuesday");
  await expect(page.getByText("Reconnecting…")).toBeHidden();
});

test("with two tabs, the one that led comes back to follow, and both stay live with one stream", async ({
  page,
  context,
  project,
  quadit,
}) => {
  const listed = await project.newTask("Book the room");
  const edited = await project.newTask("Order the chairs");
  const streams = openStreams(context);
  await notePageshow(page);
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const row = (key: string) => page.getByRole("link", { name: `Open ${key}` });
  await expect(row(listed)).toHaveText("Book the room");
  await expect.poll(streams).toBe(1);

  const other = await context.newPage();
  await other.goto(`/e2e/task/${edited}`);
  const title = other.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue("Order the chairs");

  await awayAndBack(page, async () => {
    // The other tab took the lead: it hears the server on its own.
    await quadit.agent("update", listed, "title=Book the big room");
    await title.fill("Order forty chairs");
    await title.press("Enter");
    await expect.poll(async () => (await quadit.task(edited)).title).toBe("Order forty chairs");
  });
  await expect(row(listed)).toHaveText("Book the big room");
  await expect(row(edited)).toHaveText("Order forty chairs");

  await quadit.agent("update", edited, "title=Order fifty chairs");
  await expect(row(edited)).toHaveText("Order fifty chairs");
  await expect(title).toHaveValue("Order fifty chairs");
  await expect.poll(streams).toBe(1);
  await expect(page.getByText("Reconnecting…")).toBeHidden();
  await expect(other.getByText("Reconnecting…")).toBeHidden();
});

test("a tab that follows comes back current, and the leader keeps the one stream", async ({
  page,
  context,
  project,
  quadit,
}) => {
  const key = await project.newTask("Book the flights");
  const streams = openStreams(context);
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toHaveText("Book the flights");
  await expect.poll(streams).toBe(1);

  const other = await context.newPage();
  await notePageshow(other);
  await other.goto(`/e2e/p/${project.key}/tasks`);
  const row = other.getByRole("link", { name: `Open ${key}` });
  await expect(row).toHaveText("Book the flights");

  await awayAndBack(other, () => quadit.agent("update", key, "title=Book the flights to Lisbon"));
  await expect(row).toHaveText("Book the flights to Lisbon");

  await quadit.agent("update", key, "title=Book the flights to Porto");
  await expect(row).toHaveText("Book the flights to Porto");
  await expect(page.getByRole("link", { name: `Open ${key}` })).toHaveText("Book the flights to Porto");
  await expect.poll(streams).toBe(1);
});

test("an edit still waiting to be sent when the page was left reaches the server after Back", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Order the chairs");
  await notePageshow(page);
  await page.goto(`/e2e/task/${key}`);
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue("Order the chairs");

  // The server cannot be reached: the change waits in the outbox.
  await page.route("**/changes?events=1", (route) => route.abort("internetdisconnected"));
  await title.fill("Order forty chairs");
  await title.press("Enter");
  await expect(page.getByText("1 change waiting to send")).toBeVisible();
  await page.unroute("**/changes?events=1");

  await awayAndBack(page);
  await expect.poll(async () => (await quadit.task(key)).title, { timeout: 15_000 }).toBe("Order forty chairs");
  await expect(page.getByText("1 change waiting to send")).toBeHidden();
  await expect(title).toHaveValue("Order forty chairs");
});
