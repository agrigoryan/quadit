// Comments on a page: threads on a block or on the page as a whole, their
// replies, resolving, the marks beside the blocks, the keys, and who may
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

const column = (page: Page) => page.getByRole("complementary", { name: "Comments" });
const thread = (page: Page, text: string) => column(page).getByRole("article").filter({ hasText: text });
const pageText = (page: Page) => page.getByRole("textbox", { name: "Page text" });

/** Puts the caret at the end of a block's text. */
async function caretIn(page: Page, text: string) {
  await pageText(page).getByText(text).click();
  await page.keyboard.press("End");
}

test("a thread on a block is started over a selection, answered, resolved, reopened and its reply deleted", async ({
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
  const box = column(page).getByRole("textbox", { name: "Comment on this block…" });
  await expect(box).toBeFocused();
  await box.fill("Which freeze, the code one?");
  await column(page).getByRole("button", { name: "Comment", exact: true }).click();
  const started = thread(page, "Which freeze, the code one?");
  await expect(started.getByText("Ship on Tuesday after the freeze.")).toBeVisible();
  await expect(page.getByRole("button", { name: "1 open comment thread on this block" })).toBeVisible();

  await started.getByRole("textbox", { name: "Reply…" }).fill("Yes, the code freeze.");
  await started.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(started.getByText("Yes, the code freeze.")).toBeVisible();
  await expect
    .poll(() => quadit.cli("comments", doc.id))
    .toMatch(/Which freeze, the code one\?\n {4}@ann-owner .*: Yes, the code freeze\./);

  await started.getByRole("button", { name: "Resolve" }).click();
  await expect(started).toBeHidden();
  await expect(page.getByRole("button", { name: "1 open comment thread on this block" })).toBeHidden();
  await column(page)
    .getByRole("radio", { name: /Resolved/ })
    .click();
  await thread(page, "Which freeze, the code one?").getByRole("button", { name: "Reopen" }).click();
  await expect(thread(page, "Which freeze, the code one?")).toBeHidden();
  await column(page).getByRole("radio", { name: /Open/ }).click();
  await expect(started).toBeVisible();
  await expect(page.getByRole("button", { name: "1 open comment thread on this block" })).toBeVisible();

  const reply = started.getByText("Yes, the code freeze.");
  await reply.hover();
  await started.getByRole("button", { name: "Delete comment" }).last().click();
  await expect(reply).toBeHidden();
  await expect.poll(() => quadit.cli("comments", doc.id)).not.toContain("Yes, the code freeze.");
});

test("the menu on a block's handle starts a thread; the mark beside the block opens it and the thread shows its block", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Budget", "Hire two people.\n\nBuy a server.\n");
  await page.goto(`/e2e/docs/${doc.id}`);

  await pageText(page).getByText("Buy a server.").hover();
  await page.getByRole("button", { name: "Open block menu" }).click();
  await page.getByRole("menuitem", { name: "Comment" }).click();
  const box = column(page).getByRole("textbox", { name: "Comment on this block…" });
  await expect(box).toBeFocused();
  await box.fill("Which one?");
  await box.press("Control+Enter");
  await expect(thread(page, "Which one?").getByText("Buy a server.")).toBeVisible();

  await column(page).getByRole("button", { name: "Close" }).click();
  await expect(column(page)).toBeHidden();
  await page.getByRole("button", { name: "1 open comment thread on this block" }).click();
  const opened = thread(page, "Which one?");
  await expect(opened).toHaveAttribute("aria-current", "true");

  await opened.getByRole("button", { name: "Show in the page" }).click();
  // The block flashes: an animation runs on it.
  const block = pageText(page).locator(".bn-block-content").filter({ hasText: "Buy a server." });
  await expect.poll(() => block.evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
});

test("a comment on the page as a whole, and on a database page", async ({ page, project, quadit }) => {
  const doc = await newPage(quadit, project.key, "Retro", "What went well.\n");
  await page.goto(`/e2e/docs/${doc.id}`);
  await page.getByRole("button", { name: "Comments" }).click();
  const onPage = column(page).getByRole("textbox", { name: "Comment on the page…" });
  await onPage.fill("Let us keep this short.");
  await column(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(thread(page, "Let us keep this short.").getByText("On the page")).toBeVisible();
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain("on the page\n  @ann-owner");

  const database = await newPage(quadit, project.key, "Vendors", "", "database");
  await page.goto(`/e2e/docs/${database.id}`);
  await page.getByRole("button", { name: "Comments" }).click();
  await column(page).getByRole("textbox", { name: "Comment on the page…" }).fill("Add a column for the contract.");
  await column(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(thread(page, "Add a column for the contract.")).toBeVisible();
  await expect.poll(() => quadit.cli("comments", database.id)).toContain("Add a column for the contract.");
});

test("a thread whose block was taken out of the page says so, and still opens", async ({ page, project, quadit }) => {
  const doc = await newPage(quadit, project.key, "Draft", "Keep this.\n\nCut this.\n");
  const cut = doc.blocks.get("Cut this.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${cut}`, "Why is this here?");
  await quadit.cli("do", "doc.edit", JSON.stringify({ doc: doc.id, ops: [{ op: "delete", id: cut }] }));

  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(pageText(page).getByText("Keep this.")).toBeVisible();
  await page.getByRole("button", { name: "Comments" }).click();
  const gone = thread(page, "Why is this here?");
  await expect(gone.getByText("The block this was on is gone")).toBeVisible();
  await expect(gone.getByRole("button", { name: "Show in the page" })).toBeHidden();
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
  await page.getByRole("button", { name: "1 open comment thread on this block" }).click();
  const answered = thread(page, "@coder is this still true?");
  await expect(answered.getByText("Yes, and text with format=text.")).toBeVisible();
  await expect(answered.getByText("Coder", { exact: true })).toBeVisible();

  // The question taken back, the answer stays, as the thread on its block.
  await answered.getByText("@coder is this still true?").hover();
  await answered.getByRole("button", { name: "Delete comment" }).first().click();
  const left = thread(page, "Yes, and text with format=text.");
  await expect(left.getByText("The API returns JSON.")).toBeVisible();
  await expect(left.getByText("@coder is this still true?")).toBeHidden();
  await expect(page.getByRole("button", { name: "1 open comment thread on this block" })).toBeVisible();
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain('"The API returns JSON."\n  @coder');
});

test("Ctrl+M starts a comment on the block at the caret, or with no caret on the page; Esc leaves the box, then closes the column", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Keys", "First line.\n\nSecond line.\n");
  await page.goto(`/e2e/docs/${doc.id}`);

  await caretIn(page, "Second line.");
  await page.keyboard.press("Control+m");
  const draft = column(page).getByRole("textbox", { name: "Comment on this block…" });
  await expect(draft).toBeFocused();
  await expect(column(page).getByText("Second line.")).toBeVisible();
  await page.keyboard.type("Too short?");
  await page.keyboard.press("Escape");
  // A new thread's box is put away: nothing was sent.
  await expect(draft).toBeHidden();
  await expect(column(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(column(page)).toBeHidden();

  // No caret in the text: the page's own box.
  await page.getByRole("textbox", { name: "Page title" }).click();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+m");
  const onPage = column(page).getByRole("textbox", { name: "Comment on the page…" });
  await expect(onPage).toBeFocused();
  await page.keyboard.type("Looks good.");
  await page.keyboard.press("Escape");
  await expect(onPage).not.toBeFocused();
  await expect(onPage).toHaveValue("Looks good.");
  await page.keyboard.press("Escape");
  await expect(column(page)).toBeHidden();

  await page.keyboard.press("Shift+?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByText("Comment on the block at the cursor, or on the page")).toBeVisible();
  await expect(sheet.getByText("Close the comments")).toBeVisible();
});

test("Ctrl+M in a comment box leaves what is being written alone", async ({ page, project, quadit }) => {
  const doc = await newPage(quadit, project.key, "Drafts", "First line.\n\nSecond line.\n");
  await page.goto(`/e2e/docs/${doc.id}`);

  await caretIn(page, "Second line.");
  await page.keyboard.press("Control+m");
  const draft = column(page).getByRole("textbox", { name: "Comment on this block…" });
  await expect(draft).toBeFocused();
  await page.keyboard.type("Half a thought");
  await page.keyboard.press("Control+m");
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Half a thought");
});

test("Esc on a database's cell lets go of the cell and leaves the comments open", async ({ page, project, quadit }) => {
  const database = await newPage(quadit, project.key, "Vendors", "", "database");
  await quadit.cli("row", database.id, "Acme paints");
  await page.goto(`/e2e/docs/${database.id}`);
  await page.getByRole("button", { name: "Comments" }).click();
  const grid = page.getByRole("grid");
  await grid.focus();
  await expect(grid).toHaveAttribute("aria-activedescendant", /.+/);

  await page.keyboard.press("Escape");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", /.+/);
  await expect(column(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(column(page)).toBeHidden();
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
  await page.getByRole("button", { name: "1 open comment thread on this block" }).click();
  const seen = thread(page, "Add an example?");
  await expect(seen.getByText("Be kind.")).toBeVisible();
  await expect(seen.getByRole("textbox", { name: "Reply…" })).toBeHidden();
  await expect(seen.getByRole("button", { name: "Resolve" })).toBeHidden();
  await expect(column(page).getByRole("textbox", { name: "Comment on the page…" })).toBeHidden();

  await caretIn(page, "Be kind.");
  await page.keyboard.press("Control+m");
  await expect(column(page).getByRole("textbox", { name: "Comment on this block…" })).toBeHidden();
  await context.close();
});
