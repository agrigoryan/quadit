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

  // Undoing it loses whatever was added to the task since: that is asked about first.
  await undo(page);
  const ask = page.getByRole("dialog", { name: "Undo “create “Write the release notes””?" });
  await expect(ask.getByText("It goes to the trash, with whatever was added to it since.")).toBeVisible();
  await expect(page.locator("[data-task]")).toHaveCount(1);
  await ask.getByRole("button", { name: "Undo" }).click();
  await expect(row).toBeHidden();
  await redo(page);
  await expect(row).toBeVisible();
});

test("a page moved to the trash comes back with Cmd+Z, and a rename typed in one go is one step", async ({
  page,
  project,
  quadit,
}) => {
  const title = `Handbook ${project.key}`;
  await quadit.cli("do", "doc.create", JSON.stringify({ title }));
  await page.goto("/e2e/docs");
  const tree = page.getByRole("navigation", { name: "Pages" });
  await tree.getByRole("link", { name: title }).click();
  const box = page.getByRole("textbox", { name: "Page title" });
  await expect(box).toHaveValue(title);
  await box.press("End");
  await box.pressSequentially(" for everyone", { delay: 60 });
  await expect(tree.getByRole("link", { name: `${title} for everyone` })).toBeVisible();
  // Out of the field, Cmd+Z is the page's: the whole of the typing goes back.
  await page.getByRole("main").focus();
  await undo(page);
  await expect(tree.getByRole("link", { name: title, exact: true })).toBeVisible();

  await tree.getByRole("link", { name: title, exact: true }).hover();
  await tree.getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(tree.getByRole("link", { name: title, exact: true })).toHaveCount(0);
  await page.getByRole("main").focus();
  await undo(page);
  await expect(tree.getByRole("link", { name: title, exact: true })).toBeVisible();
});

test("Cmd+[ goes back to the screen before, and Cmd+] forward again", async ({ page, project }) => {
  const key = await project.newTask("Fix the login page");
  const list = `/e2e/p/${project.key}/tasks`;
  await page.goto(list);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${key}$`));
  await page.keyboard.press("ControlOrMeta+[");
  await expect(page).toHaveURL(new RegExp(`${list}$`));
  await page.keyboard.press("ControlOrMeta+]");
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${key}$`));
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
