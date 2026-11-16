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

test("I, the copy keys and Cmd+Backspace act on the list's row", async ({ page, project, quadit, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const key = await project.newTask("Fix the login");
  const other = await project.newTask("Second row");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const open = page.getByRole("link", { name: `Open ${key}` });
  await expect(open).toBeVisible();
  await page.keyboard.press("j");
  await expect(open).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("i");
  await expect.poll(async () => (await quadit.task(key)).assignee).toBeTruthy();
  await page.keyboard.press("i");
  await expect.poll(async () => (await quadit.task(key)).assignee ?? "").toBe("");

  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await page.keyboard.press("ControlOrMeta+Period");
  await expect.poll(clipboard).toBe(key);
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect.poll(clipboard).toBe(`${key.toLowerCase()}-fix-the-login`);

  await page.keyboard.press("ControlOrMeta+Backspace");
  await expect(open).toBeHidden();
  await expect(page.getByRole("link", { name: `Open ${other}` })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(open).toBeVisible();
});

test("Cmd+A selects every task, F opens the filters, / the palette, [ folds the sidebar", async ({ page, project }) => {
  await project.newTask("One");
  await project.newTask("Two");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${project.key}-2` })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("2 selected")).toBeHidden();

  await page.keyboard.press("f");
  const filters = page.getByRole("dialog", { name: "Filter" });
  await expect(filters).toBeVisible();
  // The letter does not land in the menu's search box.
  await expect(filters.getByRole("combobox")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(filters).toBeHidden();

  await page.keyboard.press("/");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.keyboard.press("[");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.keyboard.press("[");
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
});

test("on an epic's page C makes a task in the epic, and Escape goes back", async ({ page, project, quadit }) => {
  await quadit.cli("do", "epic.create", JSON.stringify({ project: project.key, name: "Launch week" }));
  await page.goto(`/e2e/p/${project.key}/epics`);
  await page.getByRole("link", { name: "Launch week" }).click();
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Launch week" })).toBeVisible();

  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog.getByRole("button", { name: /Launch week/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project.key}/epics$`));
});

test("Cmd+Shift+O on a task with sub-tasks puts the caret in the box that adds one", async ({ page, project }) => {
  const parent = await project.newTask("Parent");
  await project.newTask("Child", `parent=${parent}`);
  await page.goto(`/e2e/task/${parent}`);
  const box = page.getByRole("textbox", { name: "Add a sub-task" });
  await expect(box).toBeVisible();
  await expect(box).not.toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+KeyO");
  await expect(box).toBeFocused();
});

test("the page's keys work while a database row is peeked", async ({ page, project, quadit }) => {
  const made = JSON.parse(
    await quadit.cli(
      "--json",
      "do",
      "doc.create",
      JSON.stringify({ kind: "database", title: "Vendors", project: project.key }),
    ),
  ) as { ref: string };
  await quadit.cli("row", made.ref, "Acme paints");
  await page.goto(`/e2e/docs/${made.ref}`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const peek = page.getByRole("dialog", { name: "Acme paints" });
  await expect(peek).toBeVisible();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
});

test("S on My work opens the status picker for the row", async ({ page, project, quadit }) => {
  const key = await project.newTask("Mine to do");
  await quadit.cli("assign", key, "@ann-owner");
  await page.goto("/e2e/my-work");
  const open = page.getByRole("link", { name: `Open ${key}` });
  await expect(open).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(open).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("s");
  await expect(page.getByRole("dialog", { name: "Change status…" })).toBeVisible();
});
