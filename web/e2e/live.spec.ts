import { expect, test } from "./quadit";

test("a title changed in another browser shows here without a reload", async ({ page, browser, project }) => {
  const key = await project.newTask("Draft the agenda");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const row = page.getByRole("link", { name: `Open ${key}` });
  await expect(row).toHaveText("Draft the agenda");

  const other = await browser.newContext();
  try {
    const elsewhere = await other.newPage();
    await elsewhere.goto(`/e2e/task/${key}`);
    const title = elsewhere.getByRole("textbox", { name: "Title" });
    await title.fill("Draft the agenda for Monday");
    await title.press("Enter");
    await expect(row).toHaveText("Draft the agenda for Monday");
  } finally {
    await other.close();
  }
});

test("a change an agent makes from the CLI shows without a reload", async ({ page, project, quadit }) => {
  const key = await project.newTask("Book the flights");
  await page.goto(`/e2e/task/${key}`);
  const properties = page.getByRole("region", { name: "Properties" });
  await expect(properties.getByRole("button", { name: "Status: Todo" })).toBeVisible();
  // The task's history is in: the page has finished loading the task (see the test below).
  await expect(page.getByRole("region", { name: "Activity" }).getByText("created this task")).toBeVisible();

  await quadit.agent("update", key, "title=Book the flights to Lisbon", "status=In Progress");
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Book the flights to Lisbon");
  await expect(properties.getByRole("button", { name: "Status: In Progress" })).toBeVisible();
});

// Opening a task fetches it whole (lib/task-detail.ts loadTask). A change that
// arrives through the live stream while that fetch is on its way must not be
// overwritten by the older fetched copy. Here the fetch is held until the
// change has arrived, which makes the race certain.
test("a change that arrives while the task is loading is not undone by the load", async ({ page, project, quadit }) => {
  const key = await project.newTask("Book the hotel");
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  let answered = () => {};
  const fetched = new Promise<void>((done) => (answered = done));
  await page.route(/\/tasks\/[^/?]+\?raw=1/, async (route) => {
    const before = await route.fetch();
    answered();
    await held;
    await route.fulfill({ response: before });
  });
  await page.goto(`/e2e/task/${key}`);
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue("Book the hotel");
  await fetched;
  await quadit.agent("update", key, "title=Book the hotel in Porto");
  await expect(title).toHaveValue("Book the hotel in Porto");
  release();
  await expect(page.getByRole("region", { name: "Activity" }).getByText("created this task")).toBeVisible();
  await expect(title).toHaveValue("Book the hotel in Porto");
});
