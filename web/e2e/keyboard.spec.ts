import type { Locator } from "@playwright/test";
import { expect, test } from "./quadit";

test("G then a letter goes to the place", async ({ page, project }) => {
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
  const title = (name: string) => page.getByRole("banner").getByRole("heading", { level: 1, name });
  // Each place with something only it shows.
  const places: [string, RegExp, Locator][] = [
    ["b", new RegExp(`/e2e/p/${project.key}/board$`), page.getByRole("tab", { name: "Board", selected: true })],
    ["t", new RegExp(`/e2e/p/${project.key}/tasks$`), page.getByRole("tab", { name: "List", selected: true })],
    ["i", /\/e2e\/inbox$/, title("Inbox")],
    ["m", /\/e2e\/my-work$/, title("My work")],
    ["d", /\/e2e\/docs$/, title("Docs")],
    ["s", /\/e2e\/settings\/general$/, page.getByRole("navigation", { name: "Settings" })],
  ];
  for (const [letter, address, shown] of places) {
    await page.keyboard.press("g");
    await page.keyboard.press(letter);
    await expect(page, `G ${letter.toUpperCase()}`).toHaveURL(address);
    await expect(shown).toBeVisible();
  }
});

test("J and K move, Space peeks, Enter opens, Escape and Back return to the same row", async ({ page, project }) => {
  const keys = [
    await project.newTask("First in line"),
    await project.newTask("Second in line"),
    await project.newTask("Third in line"),
  ];
  const list = `/e2e/p/${project.key}/tasks`;
  await page.goto(list);
  await expect(page.getByRole("link", { name: `Open ${keys[2]}` })).toBeVisible();

  // J J J K: the second row.
  for (const key of ["j", "j", "j", "k"]) await page.keyboard.press(key);
  await expect(page.getByRole("link", { name: `Open ${keys[1]}` })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(" ");
  const panel = page.getByRole("complementary", { name: keys[1] });
  await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Second in line");
  await page.keyboard.press(" ");
  await expect(panel).toBeHidden();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${keys[1]}$`));
  await expect(page.getByRole("heading", { level: 1, name: `${keys[1]} Second in line` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`${list}$`));

  // The list is where it was: Enter opens the same task again.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${keys[1]}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${list}$`));
  await expect(page.getByRole("link", { name: `Open ${keys[2]}` })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${keys[1]}$`));
});

test("Enter on a row's own control is the control's, not the list's", async ({ page, project }) => {
  const key = await project.newTask("Has a priority button");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const open = page.getByRole("link", { name: `Open ${key}` });
  await expect(open).toBeVisible();
  // The row is the one the keys are on, and Tab has gone on to its priority button.
  await page.keyboard.press("j");
  await expect(open).toHaveAttribute("aria-current", "true");
  await page
    .locator("[data-task]", { has: open })
    .getByRole("button", { name: /^Priority:/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project.key}/tasks$`));
});
