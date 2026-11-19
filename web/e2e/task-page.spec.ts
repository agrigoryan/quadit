import { fileURLToPath } from "node:url";
import { expect, test } from "./quadit";

test("a comment is added and shown", async ({ page, project }) => {
  const key = await project.newTask("Choose a logo");
  await page.goto(`/e2e/task/${key}`);
  const activity = page.getByRole("region", { name: "Activity" });
  await activity.getByRole("textbox", { name: "New comment" }).fill("The blue one reads best at small sizes.");
  await activity.getByRole("button", { name: "Send" }).click();
  await expect(
    activity.getByRole("listitem").filter({ hasText: "The blue one reads best at small sizes." }),
  ).toBeVisible();
  await page.reload();
  await expect(activity.getByText("The blue one reads best at small sizes.")).toBeVisible();
});

test("a sub-task is made under the task", async ({ page, project, quadit }) => {
  const key = await project.newTask("Launch the site");
  await page.goto(`/e2e/task/${key}`);
  await page.getByRole("button", { name: "Sub-task" }).click();
  const subtasks = page.getByRole("region", { name: "Sub-tasks" });
  await subtasks.getByRole("textbox", { name: "Add a sub-task" }).fill("Point the domain");
  await page.keyboard.press("Enter");
  await expect(subtasks.getByRole("link", { name: /Point the domain/ })).toBeVisible();
  await expect.poll(async () => (await quadit.task(`${project.key}-2`)).parent).toBe(key);
});

test("a file is attached and listed", async ({ page, project }) => {
  const key = await project.newTask("Collect the receipts");
  await page.goto(`/e2e/task/${key}`);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await (await chooser).setFiles(fileURLToPath(new URL("files/notes.txt", import.meta.url)));
  const files = page.getByRole("region", { name: "Files" });
  await expect(files.getByRole("link", { name: "Download notes.txt" })).toBeVisible();
  await page.reload();
  const download = files.getByRole("link", { name: "Download notes.txt" });
  await expect(download).toBeVisible();
  const served = await page.request.get((await download.getAttribute("href")) ?? "");
  expect(await served.text()).toContain("a small text file to attach");
});

test("the pictures of a task open one after another", async ({ page, project }) => {
  const key = await project.newTask("Pick a sprite");
  await page.goto(`/e2e/task/${key}`);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  // One dot, three times over.
  const dot = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  await (
    await chooser
  ).setFiles(["a.png", "b.png", "c.png"].map((name) => ({ name, mimeType: "image/png", buffer: dot })));
  const thumbs = page.getByRole("region", { name: "Files" }).getByRole("button", { name: /^Open / });
  await expect(thumbs).toHaveCount(3);
  const names = await thumbs.evaluateAll((all) => all.map((el) => (el.getAttribute("aria-label") ?? "").slice(5)));
  const [first, second, third] = names as [string, string, string];

  await thumbs.first().click();
  const shown = page.getByRole("dialog");
  await expect(shown.getByRole("img", { name: first })).toBeVisible();
  await expect(shown.getByText("1 / 3")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(shown.getByRole("img", { name: second })).toBeVisible();
  await shown.getByRole("button", { name: "Previous" }).click();
  await expect(shown.getByRole("img", { name: first })).toBeVisible();
  // Round from the first to the last.
  await page.keyboard.press("ArrowLeft");
  await expect(shown.getByRole("img", { name: third })).toBeVisible();
  await expect(shown.getByText("3 / 3")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(shown).toBeHidden();
});

test("Ctrl+M starts a comment, Escape leaves the box with the draft kept, and Escape again closes the panel", async ({
  page,
  project,
}) => {
  const key = await project.newTask("Pick the launch day");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await page.getByRole("link", { name: `Open ${key}` }).hover();
  await page.keyboard.press(" ");
  const panel = page.getByRole("complementary", { name: key });
  const box = panel.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeVisible();
  await expect(box).not.toBeFocused();

  await page.keyboard.press("Control+m");
  await expect(box).toBeFocused();
  await page.keyboard.type("Tuesday, after the");
  await page.keyboard.press("Escape");
  await expect(box).not.toBeFocused();
  await expect(panel).toBeVisible();
  await expect(box).toHaveValue("Tuesday, after the");

  // Back in the box, the cursor is at the end of what was typed.
  await page.keyboard.press("Control+m");
  await page.keyboard.type(" freeze");
  await expect(box).toHaveValue("Tuesday, after the freeze");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("an admin limits how often the task may pass between agents, and takes the limit off", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Paint the castle");
  await page.goto(`/e2e/task/${key}`);
  const limit = page.getByRole("region", { name: "Properties" }).getByRole("spinbutton", { name: "Hand-off limit" });
  await limit.fill("2");
  await limit.press("Enter");
  await expect.poll(async () => (await quadit.task(key)).handoff_limit).toBe(2);
  expect(await quadit.cli("show", key)).toContain("hand-offs between agents: 2 at most");
  await page.reload();
  await expect(limit).toHaveValue("2");

  await limit.fill("");
  await limit.press("Enter");
  await expect.poll(async () => (await quadit.task(key)).handoff_limit).toBeUndefined();
  await page.reload();
  await expect(limit).toHaveValue("");
});
