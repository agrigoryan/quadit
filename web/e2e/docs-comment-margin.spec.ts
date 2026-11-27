// Comment threads beside a page's text, on a window wide enough for them:
// each card level with its words, none over another, the open one where
// its words are; cards that follow the text as it is typed; the
// Discussions list in the header that scrolls to a thread, highlights its
// words and puts the cursor in its reply box; and, where the page has no
// room for a margin, the comments column as before.

import type { Locator, Page } from "@playwright/test";
import { expect, type Quadit, test } from "./quadit";

test.use({ viewport: { width: 1600, height: 1000 } });

/** Makes a page in the project from Markdown, and gives its id and its blocks' ids by their text. */
async function newPage(quadit: Quadit, project: string, title: string, markdown: string) {
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title, project, markdown })),
  ) as { ref: string };
  const read = JSON.parse(await quadit.cli("--json", "doc", made.ref)) as {
    blocks: { id: string; content?: { text?: string }[] }[];
  };
  const blocks = new Map(read.blocks.map((b) => [(b.content ?? []).map((c) => c.text ?? "").join(""), b.id]));
  return { id: made.ref, blocks };
}

const comments = (page: Page) => page.getByRole("complementary", { name: "Comments" });
const card = (page: Page, text: string) => comments(page).getByRole("article").filter({ hasText: text });
const pageText = (page: Page) => page.getByRole("textbox", { name: "Page text" });
const marked = (page: Page, words: string) =>
  pageText(page).locator('[data-style-type="comment"]').filter({ hasText: words });

const topOf = async (el: Locator) => (await el.boundingBox())?.y ?? NaN;
const bottomOf = async (el: Locator) => {
  const box = await el.boundingBox();
  return box ? box.y + box.height : NaN;
};

test("threads on words and on a block sit level with them, none over another, the open one where its words are", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(
    quadit,
    project.key,
    "Boss fight",
    `The boss has three phases and a final form.\n\n${"Then it waits.\n\n".repeat(8)}Then it runs to the gate.\n`,
  );
  const first = doc.blocks.get("The boss has three phases and a final form.") ?? "";
  const second = doc.blocks.get("Then it runs to the gate.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${first}`, "quote=three phases", "Still three?");
  await quadit.cli("comment", `page=${doc.id}`, `block=${first}`, "quote=final form", "Which form?");
  await quadit.cli("comment", `page=${doc.id}`, `block=${second}`, "Which gate?");
  await quadit.cli("comment", `page=${doc.id}`, "Short page, good.");

  await page.goto(`/e2e/docs/${doc.id}`);
  const phases = card(page, "Still three?");
  const form = card(page, "Which form?");
  const gate = card(page, "Which gate?");
  await expect(phases).toHaveAccessibleName("Comment by Ann Owner on “three phases”");
  await expect
    .poll(async () => Math.abs((await topOf(phases)) - (await topOf(marked(page, "three phases")))))
    .toBeLessThan(8);
  await expect
    .poll(async () => Math.abs((await topOf(gate)) - (await topOf(pageText(page).getByText("Then it runs")))))
    .toBeLessThan(8);
  // Both on one line: the later one below the first, not over it.
  await expect.poll(async () => (await topOf(form)) - (await bottomOf(phases))).toBeGreaterThanOrEqual(0);
  // The page's own thread is not in the margin; the marks beside the blocks give way to the cards.
  await expect(comments(page).getByText("Short page, good.")).toBeHidden();
  await expect(page.getByRole("button", { name: /open comment thread/ })).toHaveCount(0);

  // Opened, a card is where its words are, its replies and reply box shown, the others out of its way.
  await form.getByRole("button", { name: "Reply…" }).click();
  await expect(form).toHaveAttribute("aria-current", "true");
  await expect(form.getByRole("textbox", { name: "Reply…" })).toBeFocused();
  await expect
    .poll(async () => Math.abs((await topOf(form)) - (await topOf(marked(page, "final form")))))
    .toBeLessThan(8);
  await expect.poll(async () => (await topOf(form)) - (await bottomOf(phases))).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => (await topOf(gate)) - (await bottomOf(form))).toBeGreaterThanOrEqual(0);

  await page.keyboard.type("The second one.");
  await page.keyboard.press("Control+Enter");
  await expect(form.getByText("The second one.")).toBeVisible();
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain("The second one.");

  // Esc closes it, the cursor on what opens it again.
  await page.keyboard.press("Escape");
  await expect(form).not.toHaveAttribute("aria-current", "true");
  await expect(form.getByRole("button", { name: "Reply…" })).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/docs/${doc.id}$`));
});

test("the cards follow their words as lines are typed above them", async ({ page, project, quadit }) => {
  const doc = await newPage(quadit, project.key, "Moves", "First line.\n\nThe words here.\n");
  const block = doc.blocks.get("The words here.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${block}`, "quote=words here", "Keep these?");
  await page.goto(`/e2e/docs/${doc.id}`);
  const keep = card(page, "Keep these?");
  const level = async () => Math.abs((await topOf(keep)) - (await topOf(marked(page, "words here"))));
  await expect.poll(level).toBeLessThan(8);
  const before = await topOf(keep);

  await pageText(page).getByText("First line.").click();
  await page.keyboard.press("End");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Enter");
  await expect.poll(async () => (await topOf(keep)) - before).toBeGreaterThan(60);
  await expect.poll(level).toBeLessThan(8);
});

test("Discussions lists the open threads; one picked is scrolled to, highlighted, and its reply box takes the cursor", async ({
  page,
  project,
  quadit,
}) => {
  const filler = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the plan.`).join("\n\n");
  const doc = await newPage(quadit, project.key, "Long plan", `${filler}\n\nShip it on the last day.\n`);
  const last = doc.blocks.get("Ship it on the last day.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${last}`, "quote=last day", "Which day exactly?");
  await quadit.cli("comment", `page=${doc.id}`, "Who reads this?");

  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(pageText(page).getByText("Line 1 of")).toBeVisible();
  await expect(marked(page, "last day")).not.toBeInViewport();

  await page.getByRole("button", { name: /Comments/ }).click();
  const list = page.getByRole("dialog", { name: "Discussions" });
  await expect(list.getByRole("button")).toHaveText([
    /Which day exactly\?last day/,
    /Who reads this\?On the page/,
    "See all",
  ]);
  await list.getByRole("button", { name: /Which day exactly\?/ }).click();

  await expect(marked(page, "last day")).toBeInViewport();
  // The thread shown has the highlighter itself on its words.
  await expect(marked(page, "last day")).toHaveCSS("background-color", "rgb(255, 214, 10)");
  const day = card(page, "Which day exactly?");
  await expect(day).toHaveAttribute("aria-current", "true");
  await expect(day.getByRole("textbox", { name: "Reply…" })).toBeFocused();

  // A thread on the page as a whole opens in the column, its reply box taking the cursor there.
  await page.getByRole("button", { name: /Comments/ }).click();
  await list.getByRole("button", { name: /Who reads this\?/ }).click();
  const column = page.locator("[data-comments]");
  await expect(column).toBeVisible();
  await expect(
    column.getByRole("article").filter({ hasText: "Who reads this?" }).getByRole("textbox", { name: "Reply…" }),
  ).toBeFocused();
});

test("where the page has no room for a margin, a click on the words opens the thread in the column", async ({
  page,
  project,
  quadit,
}) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  const doc = await newPage(quadit, project.key, "Narrow", "The boss has three phases.\n");
  const block = doc.blocks.get("The boss has three phases.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${block}`, "quote=three phases", "Still three?");
  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(marked(page, "three phases")).toHaveCSS("border-bottom-width", "2px");
  await expect(comments(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "1 open comment thread on this block" })).toBeVisible();

  await marked(page, "three phases").click();
  const column = page.locator("[data-comments]");
  await expect(column).toBeVisible();
  await expect(column.getByRole("article").filter({ hasText: "Still three?" })).toHaveAttribute("aria-current", "true");
});
