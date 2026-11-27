// Starting and writing comments on a page: the button beside the block the
// pointer is on, and pictures given with a comment and a reply, which the
// server keeps and the threads show. Seeding and checking go through the CLI.

import type { Page } from "@playwright/test";
import { expect, type Quadit, test } from "./quadit";

/** Makes a page in the project from Markdown, and gives its id and its blocks' ids by their text. */
async function newPage(quadit: Quadit, project: string, title: string, markdown: string) {
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title, project, markdown })),
  ) as { ref: string };
  return { id: made.ref, ...(await readPage(quadit, made.ref)) };
}

/** The page as the editor reads it: its blocks' ids by their text, its comments and the files on them. */
async function readPage(quadit: Quadit, id: string) {
  const read = JSON.parse(await quadit.cli("--json", "doc", id)) as {
    blocks: { id: string; content?: { text?: string }[] }[];
    comments?: { body: string; subject_type: string; subject_id: string }[];
    attachments?: { subject_type: string; file: { name: string } }[];
  };
  return {
    blocks: new Map(read.blocks.map((b) => [(b.content ?? []).map((c) => c.text ?? "").join(""), b.id])),
    comments: read.comments ?? [],
    commentFiles: (read.attachments ?? [])
      .filter((a) => a.subject_type === "comment")
      .map((a) => a.file.name)
      .sort(),
  };
}

const column = (page: Page) => page.getByRole("complementary", { name: "Comments" });
const thread = (page: Page, text: string) => column(page).getByRole("article").filter({ hasText: text });
const pageText = (page: Page) => page.getByRole("textbox", { name: "Page text" });

/** A picture of one dot. */
const dot = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
});

test("the button beside the block the pointer is on starts a thread on that block", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Roadmap", "Ship the beta.\n\nWrite the docs.\n");
  await page.goto(`/e2e/docs/${doc.id}`);
  const add = page.getByRole("button", { name: "Comment on this block" });
  await expect(pageText(page)).toBeVisible();
  await expect(add).toBeHidden();

  // Words selected: their own Comment is the one offered.
  await pageText(page).getByText("Ship the beta.").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
  await pageText(page).getByText("Write the docs.").hover();
  await expect(add).toBeHidden();
  await page.keyboard.press("End");

  await pageText(page).getByText("Write the docs.").hover();
  await add.click();
  const box = column(page).getByRole("textbox", { name: "Comment on this block…" });
  await expect(box).toBeFocused();
  await box.fill("By when?");
  await column(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(thread(page, "By when?").getByText("Write the docs.")).toBeVisible();
  // The block shows its count where the button was.
  await expect(page.getByRole("button", { name: "1 open comment thread on this block" })).toBeVisible();
  await expect
    .poll(async () => (await readPage(quadit, doc.id)).comments.find((c) => c.body === "By when?"))
    .toMatchObject({ subject_type: "doc_block", subject_id: doc.blocks.get("Write the docs.") });
});

test("a picture given with a comment on the page and with a reply is kept and shown in the thread", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Moodboard", "Colours.\n");
  await page.goto(`/e2e/docs/${doc.id}`);
  await page.getByRole("button", { name: "Comments" }).click();

  await column(page).getByRole("textbox", { name: "Comment on the page…" }).fill("This palette.");
  const chooser = page.waitForEvent("filechooser");
  await column(page).getByRole("button", { name: "Attach files" }).click();
  await (await chooser).setFiles(dot("palette.png"));
  await expect(column(page).getByRole("button", { name: "Remove palette.png" })).toBeVisible();
  await column(page).getByRole("button", { name: "Comment", exact: true }).click();
  const started = thread(page, "This palette.");
  await expect(started.getByRole("img", { name: "palette.png" })).toBeVisible();

  await started.getByRole("textbox", { name: "Reply…" }).fill("Darker, like this.");
  const again = page.waitForEvent("filechooser");
  await started.getByRole("button", { name: "Attach files" }).click();
  await (await again).setFiles(dot("darker.png"));
  await started.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(started.getByRole("img", { name: "darker.png" })).toBeVisible();

  await expect.poll(async () => (await readPage(quadit, doc.id)).commentFiles).toEqual(["darker.png", "palette.png"]);
  // Opened afresh, the page brings them with its comments.
  await page.reload();
  await page.getByRole("button", { name: "Comments" }).click();
  await expect(thread(page, "This palette.").getByRole("img", { name: "palette.png" })).toBeVisible();
  await thread(page, "This palette.").getByRole("button", { name: "Open darker.png" }).click();
  await expect(page.getByRole("dialog", { name: "darker.png" }).getByRole("img", { name: "darker.png" })).toBeVisible();
});
