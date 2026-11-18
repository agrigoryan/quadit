// Files dropped from the Finder and pasted (a screenshot copied to the
// clipboard) reach the web app inside the app's window as they do in a
// browser: the app adds nothing and takes nothing away.

import { expect, test } from "./desktop";
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
  const comment = page.getByRole("textbox", { name: "New comment" });
  await comment.click();
  await comment.evaluate((box) => {
    const data = new DataTransfer();
    // A 1×1 PNG, as a screenshot copied to the clipboard arrives.
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    data.items.add(new File([png], "screenshot.png", { type: "image/png" }));
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("button", { name: "Remove screenshot.png" })).toBeVisible();
});
