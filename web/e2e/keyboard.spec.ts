import type { Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { OWNER } from "./run";
import { expect, invitedMember, test } from "./quadit";

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
  // Off the table, whose chosen cell would take the letter as typing (docs/db/table-view.tsx).
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
});

test("S on My work opens the status picker for the row", async ({ page, project, quadit }) => {
  const key = await project.newTask("Mine to do");
  await quadit.cli("assign", key, "@ann-owner");
  await page.goto("/e2e/my-work");
  const open = page.getByRole("link", { name: `Open ${key}` });
  await expect(open).toBeVisible();
  // Tasks of other tests that wait on the owner (a question asked of them) come first: go down to this one.
  await expect(async () => {
    await page.keyboard.press("ArrowDown");
    await expect(open).toHaveAttribute("aria-current", "true", { timeout: 500 });
  }).toPass();
  await page.keyboard.press("s");
  await expect(page.getByRole("dialog", { name: "Change status…" })).toBeVisible();
});

test("the Shift keys change the list's row, and on the open task watch and rename it", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Paint the shed");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const open = page.getByRole("link", { name: `Open ${key}` });
  await expect(open).toBeVisible();
  await page.keyboard.press("j");
  await expect(open).toHaveAttribute("aria-current", "true");

  // Shift+D: the due date's form beside the row.
  await page.keyboard.press("Shift+D");
  await page.getByLabel("Due date for 1 task").fill("2026-12-24");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Due date" })).toBeHidden();
  await expect.poll(async () => JSON.stringify(await quadit.task(key))).toContain("2026-12-24");

  // Shift+P: the epic's picker, its letter not typed into the search.
  await page.keyboard.press("Shift+P");
  const epics = page.getByRole("dialog", { name: "Set epic…" });
  await expect(epics.getByRole("combobox")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(epics).toBeHidden();

  await page.keyboard.press(" ");
  const panel = page.getByRole("complementary", { name: key });
  // The task's details in first: their watchers, read before a change, would bring back a watch just stopped.
  await expect(panel.getByRole("region", { name: "Activity" }).getByText("created this task")).toBeVisible();
  // Who made the task watches it: Shift+S stops that, and starts it again.
  const stop = panel.getByRole("button", { name: "Stop watching" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+S");
  await expect(panel.getByRole("button", { name: "Watch this task" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Shift+S");
  await expect(stop).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Shift+R");
  const title = panel.getByRole("textbox", { name: "Title" });
  await expect(title).toBeFocused();
  await page.keyboard.type("Paint the barn");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await quadit.task(key)).title).toBe("Paint the barn");
});

test("M then B marks the open task as blocked by another, picked in the list that opens", async ({ page, project }) => {
  const key = await project.newTask("Hang the door");
  const other = await project.newTask("Build the frame");
  await page.goto(`/e2e/task/${key}`);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Hang the door");

  await page.keyboard.press("m");
  await expect(page.getByRole("status", { name: "Relate to another task" })).toBeVisible();
  await page.keyboard.press("b");
  const pick = page.getByRole("dialog", { name: "Pick a task…" });
  await expect(pick).toBeVisible();
  await page.keyboard.type(other);
  await page.keyboard.press("Enter");
  await expect(pick).toBeHidden();
  await expect(page.getByRole("list", { name: "Blocked by" }).getByText("Build the frame")).toBeVisible();
});

test("Cmd+Shift+Up opens the parent and Cmd+Shift+Down the first sub-task", async ({ page, project }) => {
  const parent = await project.newTask("Paint the house");
  const child = await project.newTask("Paint the door", `parent=${parent}`);
  await page.goto(`/e2e/task/${child}`);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Paint the door");
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${parent}$`));
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Paint the house");
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${child}$`));
});

test("an epic's tasks move with J, peek with Space, are selected with X and changed with S", async ({
  page,
  project,
  quadit,
}) => {
  await quadit.cli("do", "epic.create", JSON.stringify({ project: project.key, name: "Spring cleaning" }));
  const first = await project.newTask("Sweep the porch", "epic=Spring cleaning");
  const second = await project.newTask("Wash the windows", "epic=Spring cleaning");
  await page.goto(`/e2e/p/${project.key}/epics`);
  await page.getByRole("link", { name: "Spring cleaning" }).click();
  const row = (key: string) => page.getByRole("main").getByRole("link", { name: `Open ${key}` });
  await expect(row(second)).toBeVisible();

  await page.keyboard.press("j");
  await expect(row(first)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(" ");
  await expect(page.getByRole("complementary", { name: first })).toBeVisible();
  await page.keyboard.press(" ");
  await expect(page.getByRole("complementary", { name: first })).toBeHidden();

  await page.keyboard.press("x");
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.keyboard.press("s");
  await page.getByRole("dialog", { name: "Change status…" }).getByRole("option", { name: "In Progress" }).click();
  await expect.poll(async () => (await quadit.task(first)).status).toBe("In Progress");
  await expect.poll(async () => (await quadit.task(second)).status).toBe("In Progress");

  // Escape lets go of the selection first, then leaves the page.
  await page.keyboard.press("Escape");
  await expect(page.getByText("2 selected")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project.key}/epics$`));
});

test("on the board the arrows and J/K move the focus from card to card, and S acts on the focused one", async ({
  page,
  project,
  quadit,
}) => {
  const top = await project.newTask("Buy the paint");
  const next = await project.newTask("Mix the paint");
  const across = await project.newTask("Paint the wall", "status=In Progress");
  await page.goto(`/e2e/p/${project.key}/board`);
  const card = (column: string, key: string) =>
    page.getByRole("region", { name: column, exact: true }).getByRole("link", { name: new RegExp(`${key} `) });
  await expect(card("In Progress", across)).toBeVisible();

  // No card has the focus: the first key goes to the first card.
  await page.keyboard.press("j");
  await expect(card("Todo", top)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(card("Todo", next)).toBeFocused();
  await page.keyboard.press("k");
  await expect(card("Todo", top)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(card("In Progress", across)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(card("Todo", top)).toBeFocused();

  await page.keyboard.press("s");
  await page.getByRole("dialog", { name: "Change status…" }).getByRole("option", { name: "Done" }).click();
  await expect.poll(async () => (await quadit.task(top)).status).toBe("Done");
});

test("in the inbox Option+U reads everything, Shift+Backspace archives what is read, Backspace the item", async ({
  browser,
  page: ownerPage,
  project,
  quadit,
}) => {
  // An inbox of its own, which no other test reads or archives.
  const { context } = await invitedMember(browser, ownerPage.request, `Inbox ${project.key}`);
  const handle = `inbox-${project.key.toLowerCase()}`;
  const first = await project.newTask("Read the brief");
  const second = await project.newTask("Read the notes");
  await quadit.agent("comment", first, `For you @${handle}`);
  await quadit.agent("comment", second, `And this @${handle}`);
  const page = await context.newPage();
  await page.goto("/e2e/inbox");
  const item = (key: string) => page.getByRole("link", { name: new RegExp(key) });
  await expect(item(first)).toBeVisible();
  await expect(item(second)).toBeVisible();
  const unread = page.getByRole("img", { name: "Unread" });
  await expect(unread).toHaveCount(2);

  await page.keyboard.press("Alt+KeyU");
  await expect(unread).toHaveCount(0);
  await page.keyboard.press("Shift+Backspace");
  await expect(item(first)).toHaveCount(0);
  await expect(item(second)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(item(first)).toBeVisible();
  await expect(item(second)).toBeVisible();

  // The newest first: J is on the second task's item.
  await page.keyboard.press("j");
  await expect(item(second)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Backspace");
  await expect(item(second)).toHaveCount(0);
  await expect(item(first)).toBeVisible();
  await context.close();
});

test("on the timeline - zooms out, = zooms in, 0 scrolls back to today", async ({ page, project, quadit }) => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await quadit.cli(
    "do",
    "epic.create",
    JSON.stringify({ project: project.key, name: "Long haul", start_on: day(-120), target_on: day(120) }),
  );
  await page.goto(`/e2e/p/${project.key}/timeline`);
  await expect(page.getByRole("slider", { name: "Long haul" })).toBeVisible();
  const zoom = (name: string) => page.getByRole("radio", { name });

  await page.keyboard.press("-");
  await expect(zoom("Months")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("=");
  await expect(zoom("Weeks")).toHaveAttribute("aria-checked", "true");

  // The calendar's scroller is the bar's nearest ancestor that scrolls sideways; this sets it, or only reads it.
  const scroll = (to?: number) =>
    page.getByRole("slider", { name: "Long haul" }).evaluate((bar, left) => {
      let el = bar.parentElement;
      while (el && getComputedStyle(el).overflowX !== "auto") el = el.parentElement;
      if (!el) return -1;
      if (left !== undefined) el.scrollLeft = left;
      return el.scrollLeft;
    }, to);
  await expect.poll(() => scroll()).toBeGreaterThan(0);
  await scroll(0);
  await expect.poll(() => scroll()).toBe(0);
  await page.keyboard.press("0");
  await expect.poll(() => scroll()).toBeGreaterThan(0);
});

test("Cmd+Option+P copies the open task's context pack, to paste into an agent", async ({ page, project, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const key = await project.newTask("Tune the jump", "description=Too floaty at the top.");
  await page.goto(`/e2e/task/${key}`);
  await expect(page.getByRole("heading", { level: 1, name: `${key} Tune the jump` })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+KeyP");
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await expect.poll(clipboard).toContain(`${key}  Tune the jump`);
  expect(await clipboard()).toContain("Too floaty at the top.");
});

test("N makes a page in a project's Docs, a page inside the open page, and a row on a database", async ({
  page,
  project,
  quadit,
}) => {
  await page.goto(`/e2e/p/${project.key}/docs`);
  await expect(page.getByRole("main").getByRole("button", { name: "New page" }).first()).toBeVisible();
  await page.keyboard.press("n");
  const title = page.getByRole("textbox", { name: "Page title" });
  await expect(title).toBeFocused();
  await title.fill("Roadmap");
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  const doc = async (ref: string) =>
    (JSON.parse(await quadit.cli("--json", "doc", ref)) as { doc: { title: string; parent_id?: string } }).doc;
  await expect.poll(async () => (await doc(id)).title).toBe("Roadmap");
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project.key}/docs/${id}$`));

  // Off the title: N is a key again, and makes a page inside this one.
  await title.blur();
  await page.keyboard.press("n");
  const where = page.getByRole("navigation", { name: "Where this page is" });
  await expect(where.getByRole("link", { name: "Roadmap" })).toBeVisible();
  const inside = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(inside).not.toBe(id);
  await expect.poll(async () => (await doc(inside)).parent_id).toBe(id);

  const made = JSON.parse(
    await quadit.cli(
      "--json",
      "do",
      "doc.create",
      JSON.stringify({ kind: "database", title: "Vendors", project: project.key }),
    ),
  ) as { ref: string };
  await page.goto(`/e2e/docs/${made.ref}`);
  await expect(page.getByRole("grid", { name: "Table" })).toBeVisible();
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog", { name: "Untitled" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/e2e/docs/${made.ref}\\?.*peek=`));
});

test("T moves to the open page in the tree, where F2 renames it, N adds a page inside and Cmd+Backspace trashes it", async ({
  page,
  project,
  quadit,
}) => {
  const create = async (args: object) =>
    (
      JSON.parse(await quadit.cli("--json", "do", "doc.create", JSON.stringify({ project: project.key, ...args }))) as {
        ref: string;
      }
    ).ref;
  const plan = await create({ title: `Plan ${project.key}` });
  const week = await create({ title: `Week ${project.key}`, parent: plan });
  await page.goto(`/e2e/p/${project.key}/docs/${week}`);
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(`Week ${project.key}`);
  const tree = page.getByRole("navigation", { name: "Pages" });

  await page.keyboard.press("t");
  const name = tree.getByRole("link", { name: `Week ${project.key}` });
  await expect(name).toBeFocused();

  await page.keyboard.press("F2");
  const box = tree.getByRole("textbox", { name: "Rename" });
  await box.fill(`Week one ${project.key}`);
  await page.keyboard.press("Enter");
  await expect(tree.getByRole("link", { name: `Week one ${project.key}` })).toBeFocused();
  await expect
    .poll(async () => (JSON.parse(await quadit.cli("--json", "doc", week)) as { doc: { title: string } }).doc.title)
    .toBe(`Week one ${project.key}`);

  await page.keyboard.press("n");
  const where = page.getByRole("navigation", { name: "Where this page is" });
  await expect(where.getByRole("link", { name: `Week one ${project.key}` })).toBeVisible();

  // The new page's title has the caret; off it, T finds the new page in the tree, and Up the one it is in.
  await page.getByRole("textbox", { name: "Page title" }).blur();
  await page.keyboard.press("t");
  await expect(tree.getByRole("link", { name: "Untitled" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(tree.getByRole("link", { name: `Week one ${project.key}` })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Backspace");
  await expect(tree.getByRole("link", { name: `Week one ${project.key}` })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tree.getByRole("link", { name: `Week one ${project.key}` })).toBeVisible();
});

test("J and K step the row open beside a database, in the view's order, and Enter opens it as a page", async ({
  page,
  project,
  quadit,
}) => {
  const made = JSON.parse(
    await quadit.cli(
      "--json",
      "do",
      "doc.create",
      JSON.stringify({ kind: "database", title: "Vendors", project: project.key }),
    ),
  ) as { ref: string };
  await quadit.cli("row", made.ref, "Acme paints");
  await quadit.cli("row", made.ref, "Bolt brushes");
  await page.goto(`/e2e/docs/${made.ref}`);
  await page.getByRole("button", { name: "Open", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Acme paints" })).toBeVisible();
  // The click leaves the row's title cell chosen and the table with the keys: J, K and Enter still serve the row beside.
  await expect(page.getByRole("grid", { name: "Table" })).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.getByRole("dialog", { name: "Bolt brushes" })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.getByRole("dialog", { name: "Acme paints" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/e2e\/docs\/[^/?]+$/);
  await expect(page.getByRole("main").getByRole("textbox", { name: "Page title" })).toHaveValue("Acme paints");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("D answers the open task's question asked of me: side by side when it has pictures, else on its options", async ({
  page,
  project,
  quadit,
}, testInfo) => {
  const plain = await project.newTask("Pick a colour");
  await quadit.agent("ask", plain, "Which colour?", "option=Blue", "option=Green", `ask=@${OWNER.handle}`);
  // A one-pixel picture on each option.
  const pixel = testInfo.outputPath("pixel.png");
  await writeFile(
    pixel,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const pictured = await project.newTask("Pick a logo");
  await quadit.agent(
    "ask",
    pictured,
    "Which logo?",
    "option=Round",
    `file=${pixel}`,
    "option=Square",
    `file=${pixel}`,
    `ask=@${OWNER.handle}`,
  );
  const none = await project.newTask("Nothing to answer");

  await page.goto(`/e2e/task/${plain}`);
  const question = page.getByRole("article", { name: "Which colour?" });
  await expect(question).toBeVisible();
  await page.keyboard.press("d");
  await expect(
    question.getByRole("article", { name: "Blue" }).getByRole("button", { name: "This one", exact: true }),
  ).toBeFocused();

  await page.goto(`/e2e/task/${pictured}`);
  await expect(page.getByRole("article", { name: "Which logo?" })).toBeVisible();
  await page.keyboard.press("d");
  await expect(page.getByRole("dialog", { name: "Which logo?" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`/e2e/task/${none}`);
  await expect(page.getByRole("heading", { level: 1, name: `${none} Nothing to answer` })).toBeVisible();
  await page.keyboard.press("d");
  // Exact: the screen reader's live region repeats the note after the word "Notifications".
  await expect(page.getByText("No open question here waits on your answer", { exact: true })).toBeVisible();
});

test("in a task's description Cmd+B bolds what is chosen, the box's undo takes it back, and Enter goes on with a list", async ({
  page,
  project,
}) => {
  const key = await project.newTask("Write the notes");
  await page.goto(`/e2e/task/${key}`);
  await page.getByRole("button", { name: "Add a description" }).click();
  const box = page.getByRole("textbox", { name: "Description" });
  await box.pressSequentially("make it loud");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(box).toHaveValue("make it **loud**");
  await page.keyboard.press("ControlOrMeta+i");
  await expect(box).toHaveValue("make it **_loud_**");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(box).toHaveValue("make it **loud**");

  // The caret to the end (End only scrolls on a Mac).
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.press("Enter");
  await box.pressSequentially("- [ ] milk");
  await page.keyboard.press("Enter");
  await box.pressSequentially("eggs");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("make it **loud**\n- [ ] milk\n- [ ] eggs\n");
});

test("a box of a task list in a description is ticked with a click, and Cmd+Z unticks it", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Shop", "description=- [ ] milk\n- [ ] eggs");
  await page.goto(`/e2e/task/${key}`);
  const boxes = page.getByRole("main").getByRole("checkbox");
  await expect(boxes).toHaveCount(2);
  await boxes.nth(1).click();
  await expect(boxes.nth(1)).toBeChecked();
  const description = async () =>
    (JSON.parse(await quadit.cli("--json", "show", key)) as { task: { description?: string } }).task.description;
  await expect.poll(description).toBe("- [ ] milk\n- [x] eggs");
  await page.getByRole("main").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(boxes.nth(1)).not.toBeChecked();
  await expect.poll(description).toBe("- [ ] milk\n- [ ] eggs");
});
