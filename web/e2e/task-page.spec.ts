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
