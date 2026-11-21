// Files dropped from the Finder and pasted (a screenshot copied to the
// clipboard) reach the web app inside the app's window as they do in a
// browser: the app adds nothing and takes nothing away. Quitting while one
// still uploads asks the person first (src/main/quit.ts).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Desktop, expect, test } from "./desktop";
import { newTask, quadit } from "./run";

test("a file dropped on a task is attached to it", async ({ desktop, run }) => {
  const { key } = await newTask(run, "Read the notes");
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await page.goto(`${run.server}/e2e/task/${key}`);
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toBeVisible();
  const dataTransfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["the notes\n"], "notes.txt", { type: "text/plain" }));
    return data;
  });
  await title.dispatchEvent("dragenter", { dataTransfer });
  await title.dispatchEvent("dragover", { dataTransfer });
  await title.dispatchEvent("drop", { dataTransfer });
  await expect.poll(async () => await quadit(run, ["--json", "show", key])).toContain("notes.txt");
});

test("an image pasted into the comment box comes along with the comment", async ({ desktop, run }) => {
  const { key } = await newTask(run, "Look at the screenshot");
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await page.goto(`${run.server}/e2e/task/${key}`);
  await pasteImage(page);
  await expect(page.getByRole("button", { name: "Remove screenshot.png" })).toBeVisible();
  // Sent, the comment carries it: Send waits for the image's upload. The test ends only then: while an upload is
  // under way the page holds on to itself (beforeunload, web/src/data/files.ts), and the app does not quit.
  await page.getByRole("textbox", { name: "New comment" }).fill("Here it is");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => await quadit(run, ["--json", "show", key])).toContain("screenshot.png");
});

/** Pastes a 1×1 PNG into the comment box on `page`, as a screenshot copied to the clipboard arrives. */
async function pasteImage(page: Page) {
  const comment = page.getByRole("textbox", { name: "New comment" });
  await comment.click();
  await comment.evaluate((box) => {
    const data = new DataTransfer();
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    data.items.add(new File([png], "screenshot.png", { type: "image/png" }));
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
}

test("quitting while a file uploads asks once: Don't quit keeps the app and the upload, Quit then quits", async ({
  run,
}) => {
  const desktop = await Desktop.launch(mkdtempSync(join(tmpdir(), "quadit-desktop-app-")), run);
  const exited = new Promise<void>((done) => desktop.app.process().once("exit", () => done()));
  let gone = false;
  void exited.then(() => (gone = true));
  // The upload's requests are held: it cannot finish while the test asks the app to quit.
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  try {
    const { key } = await newTask(run, "Upload while quitting");
    await desktop.addServer(run.server);
    const page = await desktop.signedIn(run.server);
    await page.route("**/files**", async (route) => {
      await held;
      await route.continue().catch(() => {}); // The app may be gone by then.
    });
    await page.goto(`${run.server}/e2e/task/${key}`);
    await pasteImage(page);
    await expect(page.getByLabel("Uploading screenshot.png")).toBeVisible();

    // Quit: the app asks; Don't quit (its default) leaves it as it was, the upload still going.
    const question = "A file is still uploading. If you quit now, the upload is lost.";
    await desktop.app.evaluate(({ app }) => app.quit());
    await expect.poll(async () => (await desktop.recorded()).dialogs).toEqual([question]);
    expect(gone).toBe(false);
    await expect(page.getByLabel("Uploading screenshot.png")).toBeVisible();
    // Closing the window now hides it, as before the quit was asked for.
    await desktop.hide(run.server);
    expect(gone).toBe(false);

    // A later Quit asks again; Quit goes through.
    await desktop.answerNextDialog(1);
    await desktop.app.evaluate(({ app }) => app.quit()).catch(() => {}); // The app may be gone before it answers.
    await exited;
  } finally {
    release();
    if (!gone) await desktop.close();
  }
});
