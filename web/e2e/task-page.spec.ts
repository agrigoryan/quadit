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
