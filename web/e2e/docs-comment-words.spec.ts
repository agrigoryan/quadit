// Comment threads on words of a page: started on a selection by a person,
// by one who may comment but not edit, and by an agent with quote=; the
// words highlighted while the thread is open, kept as people type in and
// around them (and while a thread is started on words of the block being
// typed in), detached when they are taken out and put back by an undo (and
// out again by a redo), kept through an agent's rewrite, taken along by a
// cut and a paste. Seeding and checking go through the CLI, which reads the
// threads as an agent does.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { expect, type Quadit, test } from "./quadit";
import { currentRun, fromOwnPage, WORKSPACE } from "./run";

/** Makes a page in the project from Markdown, and gives its id and its blocks' ids by their text. */
async function newPage(quadit: Quadit, project: string, title: string, markdown: string) {
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title, project, markdown })),
  ) as { ref: string };
  return { id: made.ref, blocks: await blocksOf(quadit, made.ref) };
}

/** A page's blocks' ids by their text. */
async function blocksOf(quadit: Quadit, page: string) {
  const read = JSON.parse(await quadit.cli("--json", "doc", page)) as {
    blocks: { id: string; content?: { text?: string }[] }[];
  };
  return new Map(read.blocks.map((b) => [(b.content ?? []).map((c) => c.text ?? "").join(""), b.id]));
}

const column = (page: Page) => page.getByRole("complementary", { name: "Comments" });
/** Opens the comments column: the header's comments button, then "See all" in its Discussions list. */
async function seeAll(page: Page) {
  await page.getByRole("button", { name: "Comments" }).click();
  const list = page.getByRole("dialog", { name: "Discussions" });
  await list.getByRole("button", { name: "See all" }).click();
  // Gone, not still on its way out, where it would take the next Esc for itself.
  await expect(list).toBeHidden();
}
const thread = (page: Page, text: string) => column(page).getByRole("article").filter({ hasText: text });
const pageText = (page: Page) => page.getByRole("textbox", { name: "Page text" });
/** The words a thread is on, as the page shows them. */
const marked = (page: Page, words: string) =>
  pageText(page).locator('[data-style-type="comment"]').filter({ hasText: words });

/** Selects words of the page's text with the mouse, from their first letter to their last. */
async function selectWords(page: Page, words: string) {
  const box = await pageText(page).evaluate((text, wanted) => {
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const { left, right, top, bottom } = range.getBoundingClientRect();
      return { left, right, y: (top + bottom) / 2 };
    }
    throw new Error(`no "${wanted}" in the page's text`);
  }, words);
  await page.mouse.move(box.left + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, box.y, { steps: 5 });
  await page.mouse.up();
}

/** Writes a comment in the box of a new thread on words, and sends it. */
async function writeThread(page: Page, body: string) {
  const box = column(page).getByRole("textbox", { name: "Comment on these words…" });
  await expect(box).toBeFocused();
  await box.fill(body);
  await box.press("Control+Enter");
}

test("a person comments on words; typing in and around them keeps them marked, and a click on them shows the thread", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Boss fight", "The boss has three phases.\n\nThen it runs.\n");
  const block = doc.blocks.get("The boss has three phases.") ?? "";
  await page.goto(`/e2e/docs/${doc.id}`);

  await selectWords(page, "three phases");
  await page.locator(".bn-formatting-toolbar").getByRole("button", { name: "Comment", exact: true }).click();
  await expect(column(page).getByText("three phases", { exact: true })).toBeVisible();
  await writeThread(page, "Still three?");

  const card = thread(page, "Still three?");
  await expect(card.getByText("three phases", { exact: true })).toBeVisible();
  await expect(marked(page, "three phases")).toHaveCSS("border-bottom-width", "2px");
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain(`on words of block ${block} "three phases"`);

  // Typed among the words: theirs. Typed right after them: not.
  await marked(page, "three phases").click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < " phases".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(" short");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(" now");
  await expect(marked(page, "three short phases")).toHaveText("three short phases");
  await expect(card.getByText("three short phases", { exact: true })).toBeVisible();
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain(`on words of block ${block} "three short phases"`);

  // The pointer on its card lights the words; a click on them shows their thread, its words highlighted strongest.
  const shade = () => marked(page, "three short phases").evaluate((el) => getComputedStyle(el).backgroundColor);
  await column(page).getByRole("button", { name: "Close" }).click();
  await seeAll(page);
  await page.mouse.move(0, 0);
  const tint = await shade();
  await thread(page, "Still three?").hover();
  await expect.poll(shade).not.toBe(tint);
  const lit = await shade();
  await column(page).getByRole("button", { name: "Close" }).click();
  await marked(page, "three short phases").click();
  await expect(thread(page, "Still three?")).toHaveAttribute("aria-current", "true");
  await expect.poll(shade).not.toBe(lit);
  await expect.poll(shade).not.toBe(tint);
});

test("taking the words out detaches the thread onto the page, and an undo puts it back on them", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Cutscene", "The camera pans left slowly.\n");
  const block = doc.blocks.get("The camera pans left slowly.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${block}`, "quote=pans left", "Right instead?");
  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(marked(page, "pans left")).toHaveCSS("border-bottom-width", "2px");

  await marked(page, "pans left").selectText();
  await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
  await page.keyboard.press("Backspace");
  const line = pageText(page).locator("p").filter({ hasText: "The camera" });
  await expect(line).toHaveText(/^The camera\s+slowly\.$/);
  await expect
    .poll(() => quadit.cli("comments", doc.id))
    .toContain('on the page, its words taken out of it: "pans left"');
  await seeAll(page);
  const card = thread(page, "Right instead?");
  await expect(card.getByText("The text it was on was removed")).toBeVisible();
  await expect(card.locator("del")).toHaveText("pans left");

  await line.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(marked(page, "pans left")).toHaveCSS("border-bottom-width", "2px");
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain(`on words of block ${block} "pans left"`);
  await expect(card.getByText("The text it was on was removed")).toBeHidden();
  await expect(card.getByText("pans left", { exact: true })).toBeVisible();
});

test("an agent comments on words with quote=, its rewrite keeps them marked, and resolving hides the highlight until reopened", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Level two", "Spawn four drones at noon.\n\nThe door opens.\n");
  const block = doc.blocks.get("Spawn four drones at noon.") ?? "";
  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(pageText(page).getByText("Spawn four drones at noon.")).toBeVisible();

  await quadit.agent("comment", `page=${doc.id}`, `block=${block}`, "quote=four drones", "Too many?");
  // The open page hears of it: the words light up, and the thread is there.
  await expect(marked(page, "four drones")).toHaveCSS("border-bottom-width", "2px");
  expect(await quadit.cli("doc", doc.id, "format=md")).toContain(`<span data-comment="`);

  // The agent writes the page back without the span, the words kept: they stay marked.
  await quadit.agent(
    "do",
    "doc.write",
    JSON.stringify({ doc: doc.id, markdown: "At noon: spawn four drones, then wait.\n\nThe door opens.\n" }),
  );
  await expect(pageText(page).getByText("then wait.")).toBeVisible();
  await expect(marked(page, "four drones")).toHaveCSS("border-bottom-width", "2px");
  expect(await quadit.cli("comments", doc.id)).toContain('"four drones"');

  await seeAll(page);
  await thread(page, "Too many?").getByRole("button", { name: "Resolve" }).click();
  await expect(marked(page, "four drones")).toHaveCSS("border-bottom-width", "0px");
  await column(page)
    .getByRole("radio", { name: /Resolved/ })
    .click();
  await thread(page, "Too many?").getByRole("button", { name: "Reopen" }).click();
  await expect(marked(page, "four drones")).toHaveCSS("border-bottom-width", "2px");

  // Deleting the thread takes its marker off the words.
  await column(page).getByRole("radio", { name: /Open/ }).click();
  await thread(page, "Too many?").getByText("Too many?").hover();
  await thread(page, "Too many?").getByRole("button", { name: "Delete comment" }).click();
  await expect(pageText(page).locator('[data-style-type="comment"]')).toHaveCount(0);
  await expect.poll(() => quadit.cli("doc", doc.id, "format=md")).not.toContain("data-comment");
});

test("a copy of words a thread is on, pasted elsewhere, is plain text: the thread stays on its words", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Notes", "Keep the lights low.\n\nAnd here:\n");
  const block = doc.blocks.get("Keep the lights low.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${block}`, "quote=lights low", "Why low?");
  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(marked(page, "lights low")).toHaveCSS("border-bottom-width", "2px");

  // The browser's copy and paste, as the editor hears them: what it puts on the clipboard for the
  // selection, handed back to it where the caret is. Headless Chromium has no clipboard of its own.
  await marked(page, "lights low").selectText();
  // The editor has the selection once its toolbar shows over it.
  await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
  const copied = await pageText(page).evaluateHandle((text) => {
    const data = new DataTransfer();
    text.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
    return data;
  });
  // What is copied carries the marker, as the page shows it; the paste reads none.
  expect(
    await copied.evaluate((data) => data.types.some((t) => data.getData(t).includes('data-style-type="comment"'))),
  ).toBe(true);
  await pageText(page).getByText("And here:").click();
  await page.keyboard.press("End");
  // Typed first, so that the editor has the caret where the paste goes, not the words copied.
  await page.keyboard.type(" ");
  await expect(pageText(page).getByText("And here:", { exact: true })).toHaveText("And here: ");
  await pageText(page).evaluate((text, data) => {
    text.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, copied);
  await expect(pageText(page).getByText("And here: lights low")).toBeVisible();
  await expect(pageText(page).locator('[data-style-type="comment"]')).toHaveCount(1);
  await expect.poll(() => quadit.cli("doc", doc.id, "format=md")).toContain("And here: lights low");
  expect((await quadit.cli("doc", doc.id, "format=md")).match(/data-comment=/g)).toHaveLength(1);
});

test("on a page mirrored from a read-only file, one who may only comment starts a thread on words", async ({
  page,
  project,
  quadit,
}) => {
  const exec = promisify(execFile);
  const git = (cwd: string, ...args: string[]) =>
    exec("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  const tmp = await mkdtemp(join(tmpdir(), "quadit-e2e-repo-"));
  const origin = join(tmp, "origin.git");
  const work = join(tmp, "work");
  await git(tmp, "init", "--quiet", "--bare", "-b", "main", origin);
  await git(tmp, "clone", "--quiet", origin, work);
  await writeFile(join(work, "rules.md"), `# Rules ${project.key}\n\nNo running in the hall.\n`);
  await git(work, "add", "--all");
  await git(work, "commit", "--quiet", "-m", "rules");
  await git(work, "push", "--quiet", "origin", "HEAD:main");
  const source = JSON.parse(
    await quadit.cli(
      "--json",
      "do",
      "source.create",
      JSON.stringify({ title: `Handbook ${project.key}`, repo: origin, write_mode: "none" }),
    ),
  ) as { ref: string };
  const synced = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/sources/${source.ref}/sync`, {
    headers: fromOwnPage(currentRun().url),
  });
  expect(synced.ok()).toBe(true);
  const tree = await quadit.cli("docs");
  const id = /Rules [A-Z]+ {2}\(([^)]+)\)/.exec(
    tree.split("\n").find((l) => l.includes(`Rules ${project.key}`)) ?? "",
  )?.[1];
  expect(id).toBeTruthy();

  await page.goto(`/e2e/docs/${id}`);
  await expect(page.getByText("This page mirrors a file")).toBeVisible();
  await pageText(page).locator(".bn-inline-content").filter({ hasText: "No running in the hall." }).selectText();
  await page.keyboard.press("Control+m");
  await expect(column(page).getByText("No running in the hall.")).toBeVisible();
  await writeThread(page, "Walking only?");
  await expect(marked(page, "No running in the hall.")).toHaveCSS("border-bottom-width", "2px");
  await expect.poll(() => quadit.cli("comments", id ?? "")).toContain('"No running in the hall."\n  @ann-owner');
});

test("a thread started on words of the block being typed in: its marker comes in as the typing goes on, and no key is lost", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Boss rush", "The boss has three phases.\n");
  const block = doc.blocks.get("The boss has three phases.") ?? "";
  await page.goto(`/e2e/docs/${doc.id}`);
  const line = pageText(page).locator("p").filter({ hasText: "The boss" });
  await line.click();
  await page.keyboard.press("End");

  // An agent starts a thread on words of the block while keys typed in it are not sent yet (typed
  // faster than the editor waits before it sends): the editor keeps its text, and sends it without
  // the marker. The server puts the marker back on the words. Then keys typed slower than the
  // editor waits go out one by one, and the answers come while the next keys are being typed.
  const fast = page.keyboard.type(" Then it runs away", { delay: 200 });
  await expect(line).toContainText("The boss has three phases. Then");
  await quadit.agent("comment", `page=${doc.id}`, `block=${block}`, "quote=three phases", "Four?");
  await fast;
  await page.keyboard.type(" fast, and hides.", { delay: 450 });
  await expect(line).toHaveText("The boss has three phases. Then it runs away fast, and hides.");
  await expect(marked(page, "three phases")).toHaveCSS("border-bottom-width", "2px");
  await expect
    .poll(() => quadit.cli("doc", doc.id, "format=md"))
    .toMatch(/^The boss has <span data-comment="[^"]+">three phases<\/span>\. Then it runs away fast, and hides\.$/m);
  expect(await quadit.cli("comments", doc.id)).toContain(`on words of block ${block} "three phases"`);
});

test("redo takes the words out again and detaches the thread, and undo puts it back once more", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Intro", "The camera pans left slowly.\n");
  const block = doc.blocks.get("The camera pans left slowly.") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${block}`, "quote=pans left", "Right instead?");
  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(marked(page, "pans left")).toHaveCSS("border-bottom-width", "2px");

  await marked(page, "pans left").selectText();
  await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
  await page.keyboard.press("Backspace");
  const detached = 'on the page, its words taken out of it: "pans left"';
  const attached = `on words of block ${block} "pans left"`;
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain(detached);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(marked(page, "pans left")).toHaveCSS("border-bottom-width", "2px");
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain(attached);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(marked(page, "pans left")).toHaveCount(0);
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain(detached);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(marked(page, "pans left")).toHaveCSS("border-bottom-width", "2px");
  await expect.poll(() => quadit.cli("comments", doc.id)).toContain(attached);
});

test("words cut and pasted into a block that has the same words take the thread to the copy pasted", async ({
  page,
  project,
  quadit,
}) => {
  const doc = await newPage(quadit, project.key, "Mood", "Keep the lights low.\n\nThe lights low here, and:\n");
  const block = doc.blocks.get("Keep the lights low.") ?? "";
  const other = doc.blocks.get("The lights low here, and:") ?? "";
  await quadit.cli("comment", `page=${doc.id}`, `block=${block}`, "quote=lights low", "Why low?");
  await page.goto(`/e2e/docs/${doc.id}`);
  await expect(marked(page, "lights low")).toHaveCSS("border-bottom-width", "2px");

  await marked(page, "lights low").selectText();
  await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
  // The browser's cut and paste, as the editor hears them, at once: one edit of the page takes the
  // words out of one block and puts them in the other.
  await pageText(page).evaluate(async (text) => {
    const data = new DataTransfer();
    text.dispatchEvent(new ClipboardEvent("cut", { clipboardData: data, bubbles: true, cancelable: true }));
    const target = [...text.querySelectorAll("p")].find((p) => p.textContent?.startsWith("The lights low here"));
    const last = target?.lastChild;
    if (!last) throw new Error("no block to paste in");
    const range = document.createRange();
    range.setStart(last, last.textContent?.length ?? 0);
    // The editor takes the selection when the browser tells it of the change; it listened first.
    const told = new Promise((resolve) => document.addEventListener("selectionchange", resolve, { once: true }));
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await told;
    text.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(pageText(page).getByText("The lights low here, and:lights low")).toBeVisible();
  await expect
    .poll(() => quadit.cli("doc", doc.id, "format=md"))
    .toContain('The lights low here, and:<span data-comment="');
  expect(await quadit.cli("comments", doc.id)).toContain(`on words of block ${other} "lights low"`);
});
