// A text file an agent attaches to a task opens in the viewer instead of
// downloading: Markdown rendered (or as its source), other text as written,
// one after another with the pictures, and Download always there. The same on
// a phone.

import { readFile, writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { expect, type Project, type Quadit, test } from "./quadit";

const PLAN = "# Rollout plan\n\nStep one: **ship** it.\n\n<script>document.title = 'ran'</script>\n";
// One long word, so a line too long for the screen has to wrap.
const DATA = `{"build": "green", "digest": "${"0123456789abcdef".repeat(24)}"}\n`;

/** A task with plan.md, data.json and handbook.zip attached by the agent, opened on its page. */
async function taskWithFiles(page: Page, project: Project, quadit: Quadit, testInfo: TestInfo) {
  const key = await project.newTask("Read the agent's notes");
  const paths = { plan: testInfo.outputPath("plan.md"), data: testInfo.outputPath("data.json") };
  await writeFile(paths.plan, PLAN);
  await writeFile(paths.data, DATA);
  const zip = new URL("files/handbook.zip", import.meta.url).pathname;
  await quadit.agent("attach", key, paths.plan, paths.data, zip);
  await page.goto(`/e2e/task/${key}`);
  return page.getByRole("region", { name: "Files" });
}

test("a Markdown file opens rendered, shows its source, and leads on to the next file", async ({
  page,
  project,
  quadit,
}, testInfo) => {
  const files = await taskWithFiles(page, project, quadit, testInfo);
  // A file the viewer cannot show still downloads.
  await expect(files.getByRole("link", { name: "Download handbook.zip" })).toBeVisible();

  await files.getByRole("button", { name: "Open plan.md" }).click();
  const viewer = page.getByRole("dialog", { name: "plan.md" });
  await expect(viewer.getByRole("heading", { name: "Rollout plan" })).toBeVisible();
  await expect(viewer.getByText("1 / 2")).toBeVisible();
  // The script in it is words on the screen, and never ran.
  await expect(viewer.getByText("<script>document.title = 'ran'</script>")).toBeVisible();
  expect(await page.title()).not.toBe("ran");

  await viewer.getByRole("radio", { name: "Source" }).click();
  await expect(viewer.getByText("Step one: **ship** it.")).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "Rollout plan" })).toBeHidden();

  await viewer.getByRole("button", { name: "Next" }).click();
  const json = page.getByRole("dialog", { name: "data.json" });
  await expect(json.getByText('"build": "green"')).toBeVisible();
  await expect(json.getByRole("radio", { name: "Source" })).toBeHidden();

  const download = page.waitForEvent("download");
  await json.getByRole("link", { name: "Download" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("data.json");
  expect(await readFile(await file.path(), "utf8")).toBe(DATA);

  // The arrow keys go on round, back to the Markdown, and Escape closes.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "plan.md" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  /** Nothing runs off the side: the page and the text both fit the width. */
  async function fitsTheWidth(page: Page) {
    const [content, screen] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(content).toBeLessThanOrEqual(screen);
    const text = page.getByRole("dialog").getByRole("region");
    const [inside, outside] = await text.evaluate((box) => [box.scrollWidth, box.clientWidth]);
    expect(inside).toBeLessThanOrEqual(outside);
  }

  /** The control is on the screen, whole. */
  async function onScreen(page: Page, control: ReturnType<Page["getByRole"]>) {
    const box = await control.boundingBox();
    const screen = page.viewportSize();
    expect(box && screen).toBeTruthy();
    if (!box || !screen) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(screen.width);
    expect(box.y + box.height).toBeLessThanOrEqual(screen.height);
  }

  test("the viewer fits, the text wraps and scrolls inside it, and its controls are in reach", async ({
    page,
    project,
    quadit,
  }, testInfo) => {
    const files = await taskWithFiles(page, project, quadit, testInfo);
    await files.getByRole("button", { name: "Open plan.md" }).tap();
    const viewer = page.getByRole("dialog", { name: "plan.md" });
    await expect(viewer.getByRole("heading", { name: "Rollout plan" })).toBeVisible();
    await fitsTheWidth(page);
    for (const control of [
      viewer.getByRole("link", { name: "Download" }),
      viewer.getByRole("button", { name: "Close" }),
      viewer.getByRole("button", { name: "Next" }),
      viewer.getByRole("radio", { name: "Source" }),
    ])
      await onScreen(page, control);

    await viewer.getByRole("radio", { name: "Source" }).tap();
    await expect(viewer.getByText("Step one: **ship** it.")).toBeVisible();

    await viewer.getByRole("button", { name: "Next" }).tap();
    const json = page.getByRole("dialog", { name: "data.json" });
    await expect(json.getByText('"build": "green"')).toBeVisible();
    await fitsTheWidth(page);

    const download = page.waitForEvent("download");
    await json.getByRole("link", { name: "Download" }).tap();
    expect((await download).suggestedFilename()).toBe("data.json");
    await json.getByRole("button", { name: "Close" }).tap();
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
