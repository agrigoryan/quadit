// Cmd+Z and Shift+Cmd+Z: an edit is taken back and made again on the page
// and on the server, a field keeps its own undo, and the palette names what
// would be undone.

import type { Page } from "@playwright/test";
import { expect, test } from "./quadit";

const undo = (page: Page) => page.keyboard.press("ControlOrMeta+z");
const redo = (page: Page) => page.keyboard.press("ControlOrMeta+Shift+z");

/** Presses P on the focused row and picks a priority from the keyboard. */
async function setPriority(page: Page, choice: string) {
  await page.keyboard.press("p");
  const search = page.getByRole("combobox", { name: "Set priority…" });
  await search.pressSequentially(choice);
  await page.keyboard.press("Enter");
  await expect(search).toBeHidden();
}

test("Cmd+Z takes a change back and Shift+Cmd+Z makes it again, on the server too", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Fix the login page", "priority=low");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();
  await page.keyboard.press("j");
  await setPriority(page, "Urgent");
  await expect(page.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  await expect.poll(() => quadit.task(key)).toMatchObject({ priority: "urgent" });

  await undo(page);
  await expect(page.getByRole("button", { name: "Priority: Low" })).toBeVisible();
  await expect(page.getByText(`Undone: change the priority of ${key}`)).toBeVisible();
  await expect.poll(() => quadit.task(key)).toMatchObject({ priority: "low" });

  await redo(page);
  await expect(page.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  await expect.poll(() => quadit.task(key)).toMatchObject({ priority: "urgent" });

  // The palette offers the same, and says what it would undo.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Command palette" }).fill("undo");
  await palette.getByRole("option", { name: `Undo: change the priority of ${key}` }).click();
  await expect(page.getByRole("button", { name: "Priority: Low" })).toBeVisible();
});

test("a task just made is undone into the trash, and done again out of it", async ({ page, project }) => {
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Task title" }).fill("Write the release notes");
  await dialog.getByRole("button", { name: /^Create task/ }).click();
  const row = page.getByRole("link", { name: `Open ${project.key}-1` });
  await expect(row).toBeVisible();

  await undo(page);
  await expect(row).toBeHidden();
  await redo(page);
  await expect(row).toBeVisible();
});

test("in a field Cmd+Z is the text's own undo, not the list's", async ({ page, project, quadit }) => {
  const key = await project.newTask("Tidy the backlog", "priority=low");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();
  await page.keyboard.press("j");
  await setPriority(page, "Urgent");
  await expect(page.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();

  const filter = page.getByRole("searchbox", { name: "Filter by title or key…" });
  await filter.click();
  await filter.pressSequentially("Tidy");
  await undo(page);
  await expect(page.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  await expect.poll(() => quadit.task(key)).toMatchObject({ priority: "urgent" });
});
