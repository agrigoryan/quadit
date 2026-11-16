import type { Page } from "@playwright/test";
import { expect, test } from "./quadit";

test("C makes a task and it shows in the list", async ({ page, project }) => {
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Task title" }).fill("Write the release notes");
  await dialog.getByRole("button", { name: /^Create task/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name: `Open ${project.key}-1` })).toHaveText("Write the release notes");
});

test("the New task button makes a task too", async ({ page, project }) => {
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await page.getByRole("banner").getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Task title" }).fill("Book the venue");
  await dialog.getByRole("button", { name: /^Create task/ }).click();
  await expect(page.getByRole("link", { name: `Open ${project.key}-1` })).toHaveText("Book the venue");
});

const PICKERS: Record<string, string> = { s: "Change status…", a: "Assign to…", p: "Set priority…" };

/** Presses a row key (S, A, P) and picks the choice from the keyboard: typing narrows the picker, Enter picks. */
async function pickWithKey(page: Page, letter: string, choice: string) {
  await page.keyboard.press(letter);
  const picker = page.getByRole("dialog", { name: PICKERS[letter] });
  const search = picker.getByRole("combobox", { name: PICKERS[letter] });
  await expect(search).toBeFocused();
  await search.pressSequentially(choice);
  await page.keyboard.press("Enter");
  await expect(search).toBeHidden();
}

test("P, A and S change the focused row", async ({ page, project, quadit }) => {
  const key = await project.newTask("Fix the login page");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();

  await page.keyboard.press("j");
  await pickWithKey(page, "p", "Urgent");
  await expect(page.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  await pickWithKey(page, "a", "Ann");
  await expect(page.getByRole("button", { name: "Assignee: Ann Owner" })).toBeVisible();
  // Last: grouped by status, the row moves to another group (see the test below).
  await pickWithKey(page, "s", "In Progress");
  await expect(page.getByRole("button", { name: "Status: In Progress" })).toBeVisible();

  await expect
    .poll(() => quadit.task(key))
    .toMatchObject({
      status: "In Progress",
      assignee: "@ann-owner",
      priority: "urgent",
    });
});

// S moves the row to another status group; the focus goes with the task, so the next key still lands on it.
test("the focus stays on a row that S moved to another group", async ({ page, project, quadit }) => {
  const key = await project.newTask("Fix the signup page");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();
  await page.keyboard.press("j");
  await pickWithKey(page, "s", "In Progress");
  await pickWithKey(page, "p", "Urgent");
  await expect.poll(() => quadit.task(key)).toMatchObject({ status: "In Progress", priority: "urgent" });
});

test("the task page changes status, assignee and priority", async ({ page, project, quadit }) => {
  const key = await project.newTask("Plan the offsite");
  await page.goto(`/e2e/task/${key}`);
  const properties = page.getByRole("region", { name: "Properties" });

  await properties.getByRole("button", { name: "Status: Todo" }).click();
  await page.getByRole("option", { name: "Done" }).click();
  await expect(properties.getByRole("button", { name: "Status: Done" })).toBeVisible();

  await properties.getByRole("button", { name: "Assignee: Unassigned" }).click();
  await page.getByRole("option", { name: /Ann Owner/ }).click();
  await expect(properties.getByRole("button", { name: /^Assignee: Ann Owner/ })).toBeVisible();

  await properties.getByRole("button", { name: "Priority: No priority" }).click();
  await page.getByRole("option", { name: "Low" }).click();
  await expect(properties.getByRole("button", { name: "Priority: Low" })).toBeVisible();

  await expect.poll(() => quadit.task(key)).toMatchObject({ status: "Done", assignee: "@ann-owner", priority: "low" });
});

test("filters by text and by status, in the address, through a reload", async ({ page, project }) => {
  const alpha = await project.newTask("Alpha report");
  const beta = await project.newTask("Beta report", "status=In Progress");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${beta}` })).toBeVisible();

  await page.getByRole("searchbox", { name: "Filter by title or key…" }).fill("Alpha");
  await expect(page.getByRole("link", { name: `Open ${beta}` })).toBeHidden();
  await expect(page.getByRole("link", { name: `Open ${alpha}` })).toBeVisible();
  await expect(page).toHaveURL(/[?&]q=Alpha/);
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Filter by title or key…" })).toHaveValue("Alpha");
  await expect(page.getByRole("link", { name: `Open ${alpha}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${beta}` })).toBeHidden();

  await page.getByRole("searchbox", { name: "Filter by title or key…" }).clear();
  await expect(page.getByRole("link", { name: `Open ${beta}` })).toBeVisible();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("dialog", { name: "Filter" }).getByRole("option", { name: "Status", exact: true }).click();
  await page.getByRole("dialog", { name: "Status" }).getByRole("option", { name: "In Progress" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: `Open ${alpha}` })).toBeHidden();
  await expect(page).toHaveURL(/[?&]status=In(\+|%20)Progress/);
  await page.reload();
  await expect(page.getByRole("link", { name: `Open ${beta}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${alpha}` })).toBeHidden();
});

test("a group folds and unfolds", async ({ page, project }) => {
  const key = await project.newTask("Tidy the backlog");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const todo = page.getByRole("region", { name: "Todo" });
  await expect(todo.getByRole("link", { name: `Open ${key}` })).toBeVisible();
  await todo.getByRole("button", { name: "Collapse Todo" }).click();
  await expect(todo.getByRole("link", { name: `Open ${key}` })).toBeHidden();
  await todo.getByRole("button", { name: "Expand Todo" }).click();
  await expect(todo.getByRole("link", { name: `Open ${key}` })).toBeVisible();
});

test("a parent's arrow folds its sub-tasks and leaves Space to the list", async ({ page, project }) => {
  const parent = await project.newTask("Launch the site");
  const child = await project.newTask("Point the domain", `parent=${parent}`);
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const sub = page.getByRole("link", { name: `Open ${child}` });
  await expect(sub).toBeVisible();
  // How far the sub-tasks have got is read with the title: before the chips at the row's far end.
  const titleEnd = await page.getByRole("link", { name: `Open ${parent}` }).evaluate((el) => {
    const words = document.createRange();
    words.selectNodeContents(el);
    return words.getBoundingClientRect().right;
  });
  const row = page.locator("[data-task]", { has: page.getByRole("link", { name: `Open ${parent}` }) });
  const pillStart = await row.getByTitle("0 of 1 sub-tasks done").evaluate((el) => el.getBoundingClientRect().left);
  expect(pillStart - titleEnd).toBeLessThan(16);

  await page.getByRole("button", { name: `Hide the sub-tasks of ${parent}` }).click();
  await expect(sub).toBeHidden();
  // The mouse is on the parent's row, so that is the row Space shows; the arrow did not keep the keyboard.
  await page.keyboard.press(" ");
  const panel = page.getByRole("complementary", { name: parent });
  await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Launch the site");
  await page.keyboard.press(" ");
  await expect(panel).toBeHidden();
  await expect(sub).toBeHidden();

  // Tabbed to, the arrow answers Space itself; J takes the keys back to the list.
  await page.getByRole("button", { name: `Show the sub-tasks of ${parent}` }).focus();
  await page.keyboard.press(" ");
  await expect(sub).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  await expect(page.getByRole("complementary", { name: child })).toBeVisible();
  await expect(sub).toBeVisible();
});
