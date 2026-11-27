// Comments on a page, at a window with no room for a margin (Notion's
// "minimal" comments): threads on a block open from the mark at its end in
// a popover, threads on the page as a whole sit under its title, and the
// comments pane lists them all; replies, resolving, the keys, and who may
// write them. Seeding and checking go through the CLI, which reads the
// threads as an agent does.

import type { Page } from "@playwright/test";
import { expect, invitedMember, type Quadit, test } from "./quadit";

/** Makes a page in the project from Markdown, and gives its id and its blocks' ids by their text. */
async function newPage(quadit: Quadit, project: string, title: string, markdown: string, kind?: string) {
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title, project, markdown, kind })),
  ) as { ref: string };
  const read = JSON.parse(await quadit.cli("--json", "doc", made.ref)) as {
    blocks: { id: string; content?: { text?: string }[] }[];
  };
  const blocks = new Map(read.blocks.map((b) => [(b.content ?? []).map((c) => c.text ?? "").join(""), b.id]));
  return { id: made.ref, blocks };
}

/** The threads of a block, opened in place. */
const popover = (page: Page) => page.getByRole("dialog", { name: "Comments" });
/** The page's own discussion, under its title. */
const onPage = (page: Page) => page.getByRole("region", { name: "Comments on the page" });
/** The comments pane, every thread in a list. */
const pane = (page: Page) => page.getByRole("complementary", { name: "Comments" });
const thread = (where: ReturnType<typeof popover>, text: string) =>
  where.getByRole("article").filter({ hasText: text });
const pageText = (page: Page) => page.getByRole("textbox", { name: "Page text" });
const mark = (page: Page, n: number) =>
  page.getByRole("button", { name: `${n} open comment thread${n === 1 ? "" : "s"} on this block` });

/** Opens the comments pane: the header's comments button, then "See all" in its Discussions list. */
async function seeAll(page: Page) {
  await page.getByRole("button", { name: "Comments" }).click();
  const list = page.getByRole("dialog", { name: "Discussions" });
  await list.getByRole("button", { name: "See all" }).click();
  // Gone, not still on its way out, where it would take the next Esc for itself; the pane has the cursor.
  await expect(list).toBeHidden();
  await expect(page.locator("[data-comments]")).toBeFocused();
}

/** Puts the caret at the end of a block's text. */
async function caretIn(page: Page, text: string) {
  await pageText(page).getByText(text).click();
  await page.keyboard.press("End");
}

test("a thread started over a selection is answered, resolved from the pane, reopened and its reply deleted", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(
    quadit,
    project.key,
    "Launch notes",
    "Ship on Tuesday after the freeze.\n\nThen tell support.\n",
  );
  await page.goto(`/e2e/docs/${doc.id}`);

  await caretIn(page, "Ship on Tuesday");
  await page.keyboard.press("Shift+Home");
  await page.locator(".bn-formatting-toolbar").getByRole("button", { name: "Comment", exact: true }).click();
  const box = popover(page).getByRole("textbox", { name: "Comment on these words…" });
  await expect(box).toBeFocused();
  await box.fill("Which freeze, the code one?");
  await popover(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(popover(page)).toBeHidden();
  await expect(mark(page, 1)).toBeVisible();

  await mark(page, 1).click();
  const started = thread(popover(page), "Which freeze, the code one?");
  const reply = started.getByRole("textbox", { name: "Reply…" });
  await expect(reply).toBeFocused();
  await reply.fill("Yes, the code freeze.");
  await started.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(started.getByText("Yes, the code freeze.")).toBeVisible();
  await expect
    .poll(() => quadit.cli("comments", doc.id))
    .toMatch(/Which freeze, the code one\?\n {4}@ann-owner .*: Yes, the code freeze\./);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();

  await seeAll(page);
  const listed = thread(pane(page), "Which freeze, the code one?");
  await listed.getByRole("button", { name: "Resolve" }).click();
  await expect(listed).toBeHidden();
  await expect(mark(page, 1)).toBeHidden();
  await pane(page)
    .getByRole("radio", { name: /Resolved/ })
    .click();
  await thread(pane(page), "Which freeze, the code one?").getByRole("button", { name: "Reopen" }).click();
  await expect(thread(pane(page), "Which freeze, the code one?")).toBeHidden();
  await pane(page).getByRole("radio", { name: /Open/ }).click();
  await expect(listed).toBeVisible();
  await expect(mark(page, 1)).toBeVisible();

  const answer = listed.getByText("Yes, the code freeze.");
  await answer.hover();
  await listed.getByRole("button", { name: "Delete comment" }).last().click();
  await expect(answer).toBeHidden();
  await expect.poll(() => quadit.cli("comments", doc.id)).not.toContain("Yes, the code freeze.");
});

test("the menu on a block's handle starts a thread; the mark at the end of the block opens it there", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Budget", "Hire two people.\n\nBuy a server.\n");
  await page.goto(`/e2e/docs/${doc.id}`);

  await pageText(page).getByText("Buy a server.").hover();
  await page.getByRole("button", { name: "Open block menu" }).click();
  await page.getByRole("menuitem", { name: "Comment" }).click();
  const box = popover(page).getByRole("textbox", { name: "Comment on this block…" });
  await expect(box).toBeFocused();
  await box.fill("Which one?");
  await box.press("Control+Enter");
  await expect(popover(page)).toBeHidden();

  // The mark sits just past the block's text, not at the far end of the page.
  const line = await pageText(page).getByText("Buy a server.").boundingBox();
  const text = await pageText(page).boundingBox();
  const at = await mark(page, 1).boundingBox();
  if (!line || !text || !at) throw new Error("not laid out");
  expect(at.y).toBeLessThan(line.y + line.height);
  expect(at.x).toBeLessThan(text.x + text.width);

  await mark(page, 1).click();
  await expect(thread(popover(page), "Which one?")).toHaveAttribute("aria-current", "true");
  await expect(popover(page).getByRole("textbox", { name: "Reply…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(mark(page, 1)).toBeFocused();
});

test("a comment on the page as a whole sits under its title, on a page and on a database", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Retro", "What went well.\n");
  await page.goto(`/e2e/docs/${doc.id}`);
  await page.getByRole("textbox", { name: "Page title" }).hover();
  await onPage(page).getByRole("button", { name: "Add comment" }).click();
  await onPage(page).getByRole("textbox", { name: "Comment on the page…" }).fill("Let us keep this short.");
  await onPage(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(onPage(page).getByText("Let us keep this short.")).toBeVisible();
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain("on the page\n  @ann-owner");
  // Nowhere else in the page: not at its end.
  await expect(page.getByText("Let us keep this short.")).toHaveCount(1);

  const database = await newPage(quadit, project.key, "Vendors", "", "database");
  await page.goto(`/e2e/docs/${database.id}`);
  await page.getByRole("textbox", { name: "Page title" }).hover();
  await onPage(page).getByRole("button", { name: "Add comment" }).click();
  await onPage(page).getByRole("textbox", { name: "Comment on the page…" }).fill("Add a column for the contract.");
  await onPage(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(onPage(page).getByText("Add a column for the contract.")).toBeVisible();
  await expect.poll(() => quadit.cli("comments", database.id)).toContain("Add a column for the contract.");
});

test("a thread whose block was taken out of the page says so under the title, and still opens", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Draft", "Keep this.\n\nCut this.\n");
  const cut = doc.blocks.get("Cut this.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${cut}`, "Why is this here?");
  await quadit.cli("do", "doc.edit", JSON.stringify({ doc: doc.id, ops: [{ op: "delete", id: cut }] }));

  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(pageText(page).getByText("Keep this.")).toBeVisible();
  const gone = thread(onPage(page), "Why is this here?");
  await expect(gone.getByText("The block this was on is gone")).toBeVisible();
  await gone.getByRole("button", { name: "Reply…" }).click();
  await gone.getByRole("textbox", { name: "Reply…" }).fill("It was moved to the plan.");
  await gone.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(gone.getByText("It was moved to the plan.")).toBeVisible();
  // Taken by the server, not only shown ahead of its answer.
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain("It was moved to the plan.");
});

test("an agent's reply from the command line shows in the thread", async ({ page, project, quadit }) => {
  const doc = await newPage(quadit, project.key, "Specs", "The API returns JSON.\n");
  const block = doc.blocks.get("The API returns JSON.") ?? "";
  const asked = await quadit.cli("--json", "comment", `page=${doc.id}`, `block=${block}`, "@coder is this still true?");
  const { ref } = JSON.parse(asked) as { ref: string };
  await quadit.agent("reply", ref, "Yes, and text with format=text.");

  await page.goto(`/e2e/docs/${doc.id}`);
  await mark(page, 1).click();
  const answered = thread(popover(page), "@coder is this still true?");
  await expect(answered.getByText("Yes, and text with format=text.")).toBeVisible();
  await expect(answered.getByText("Coder", { exact: true })).toBeVisible();

  // The question taken back, the answer stays, as the thread on its block.
  await answered.getByText("@coder is this still true?").hover();
  await answered.getByRole("button", { name: "Delete comment" }).first().click();
  const left = thread(popover(page), "Yes, and text with format=text.");
  await expect(left).toBeVisible();
  await expect(left.getByText("@coder is this still true?")).toBeHidden();
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain('"The API returns JSON."\n  @coder');
});

test("Ctrl+M starts a comment on the block at the caret, or with no caret on the page; Esc puts the box away, keeping what was written", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Keys", "First line.\n\nSecond line.\n");
  await page.goto(`/e2e/docs/${doc.id}`);

  await caretIn(page, "Second line.");
  await page.keyboard.press("Control+m");
  const draft = popover(page).getByRole("textbox", { name: "Comment on this block…" });
  await expect(draft).toBeFocused();
  await page.keyboard.type("Too short?");
  await page.keyboard.press("Escape");
  // Put away, nothing sent; the draft waits for its block.
  await expect(popover(page)).toBeHidden();
  await caretIn(page, "Second line.");
  await page.keyboard.press("Control+m");
  await expect(popover(page).getByRole("textbox", { name: "Comment on this block…" })).toHaveValue("Too short?");
  await popover(page).getByRole("button", { name: "Cancel" }).click();
  await expect(popover(page)).toBeHidden();
  // Cancelled on purpose: gone.
  await caretIn(page, "Second line.");
  await page.keyboard.press("Control+m");
  await expect(popover(page).getByRole("textbox", { name: "Comment on this block…" })).toHaveValue("");
  await page.keyboard.press("Escape");
  // A new thread put away leaves Esc to the page again: back out of it.
  await page.getByRole("textbox", { name: "Page title" }).click();
  await page.locator("body").click({ position: { x: 5, y: 5 } });

  // No caret in the text: the page's own box, under its title.
  await page.keyboard.press("Control+m");
  const onTheWhole = onPage(page).getByRole("textbox", { name: "Comment on the page…" });
  await expect(onTheWhole).toBeFocused();
  await page.keyboard.type("Looks good.");
  await page.keyboard.press("Escape");
  await expect(onTheWhole).toBeHidden();
  await page.keyboard.press("Control+m");
  await expect(onPage(page).getByRole("textbox", { name: "Comment on the page…" })).toHaveValue("Looks good.");

  await page.keyboard.press("Escape");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByText("Comment on the words selected, the block at the cursor, or the page")).toBeVisible();
  await expect(sheet.getByText("Close the open comment, or the comments pane, away from a comment box")).toBeVisible();
});

test("Ctrl+M pressed the moment the caret reaches another block comments on that block", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Quick keys", "First line.\n\nSecond line.\n");
  await page.goto(`/e2e/docs/${doc.id}`);
  await caretIn(page, "First line.");
  // The caret moves and the key comes in one go, before the page has had a
  // moment to hear of the move: as a fast typist, or a busy machine, does it.
  await pageText(page).evaluate((text) => {
    const line = [...text.querySelectorAll("p")].find((p) => p.textContent === "Second line.");
    if (!line?.firstChild) throw new Error("no second line");
    document.getSelection()?.collapse(line.firstChild, "Second line.".length);
    text.dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", ctrlKey: true, bubbles: true }));
  });
  await expect(popover(page).getByRole("textbox", { name: "Comment on this block…" })).toBeFocused();
  await popover(page).getByRole("textbox", { name: "Comment on this block…" }).fill("Here.");
  await popover(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain(`on block ${doc.blocks.get("Second line.")}`);
});

test("Ctrl+M in a comment box leaves what is being written alone", async ({ page, project, quadit }) => {
  const doc = await newPage(quadit, project.key, "Drafts", "First line.\n\nSecond line.\n");
  const first = doc.blocks.get("First line.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${first}`, "Is this right?");
  await page.goto(`/e2e/docs/${doc.id}`);

  await caretIn(page, "Second line.");
  await page.keyboard.press("Control+m");
  const draft = popover(page).getByRole("textbox", { name: "Comment on this block…" });
  await expect(draft).toBeFocused();
  await page.keyboard.type("Half a thought");
  await page.keyboard.press("Control+m");
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Half a thought");
  await page.keyboard.press("Escape");

  // In a reply box too, with no words selected in the text: no comment on the page is started.
  await mark(page, 1).click();
  const reply = popover(page).getByRole("textbox", { name: "Reply…" });
  await expect(reply).toBeFocused();
  await page.keyboard.type("Not sure");
  await page.keyboard.press("Control+m");
  await expect(reply).toBeFocused();
  await expect(reply).toHaveValue("Not sure");
  await expect(onPage(page).getByRole("textbox", { name: "Comment on the page…" })).toBeHidden();
});

test("Esc on a database's cell lets go of the cell and leaves the comments pane open", async ({
  page,
  project,
  quadit,
}) => {
  const database = await newPage(quadit, project.key, "Vendors", "", "database");
  await quadit.cli("row", database.id, "Acme paints");
  await page.goto(`/e2e/docs/${database.id}`);
  await seeAll(page);
  const grid = page.getByRole("grid");
  await grid.focus();
  await expect(grid).toHaveAttribute("aria-activedescendant", /.+/);

  await page.keyboard.press("Escape");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", /.+/);
  await expect(pane(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pane(page)).toBeHidden();
});

test("a read-only member reads a page's comments and has no way to add one", async ({
  browser,
  page: ownerPage,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Policy", "Be kind.\n");
  const block = doc.blocks.get("Be kind.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${block}`, "Add an example?");
  const { context, userID } = await invitedMember(browser, ownerPage.request, `Reader ${project.key}`);
  await quadit.cli("do", "member.update", JSON.stringify({ id: userID, scope: { read_only: true } }));
  const page = await context.newPage();

  await page.goto(`/e2e/docs/${doc.id}`);
  await mark(page, 1).click();
  const seen = thread(popover(page), "Add an example?");
  await expect(seen).toBeVisible();
  // No reply box: the cursor is put on the thread itself.
  await expect(seen).toBeFocused();
  await expect(seen.getByRole("textbox", { name: "Reply…" })).toBeHidden();
  await expect(seen.getByRole("button", { name: "Resolve" })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(onPage(page).getByRole("button", { name: "Add comment" })).toHaveCount(0);

  await caretIn(page, "Be kind.");
  await page.keyboard.press("Control+m");
  await expect(page.getByRole("textbox", { name: "Comment on this block…" })).toBeHidden();
  await context.close();
});
