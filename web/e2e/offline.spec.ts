import { expect, test } from "./quadit";

test("a title edited offline reaches the server once back online", async ({ page, context, project, quadit }) => {
  const key = await project.newTask("Order the chairs");
  await page.goto(`/e2e/task/${key}`);
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue("Order the chairs");

  await context.setOffline(true);
  await title.fill("Order forty chairs");
  await title.press("Enter");
  await expect(title).toHaveValue("Order forty chairs");
  const waiting = page.getByText("1 change waiting to send");
  await expect(waiting).toBeVisible();
  // Held back while offline: the server still has the old title.
  expect((await quadit.task(key)).title).toBe("Order the chairs");

  await context.setOffline(false);
  await expect.poll(async () => (await quadit.task(key)).title, { timeout: 15_000 }).toBe("Order forty chairs");
  await expect(waiting).toBeHidden();
});

// A page reloaded a moment after a change: the request is called off on its
// way, and the browser drops a write to IndexedDB that the page had not
// finished. The change must still reach the server, sent by the next page.
test("a change made just before a reload reaches the server from the next page", async ({ page, project, quadit }) => {
  const made = JSON.parse(
    await quadit.cli(
      "--json",
      "do",
      "doc.create",
      JSON.stringify({ kind: "database", title: "Vendors", project: project.key }),
    ),
  ) as { ref: string };
  await quadit.cli("do", "property.create", JSON.stringify({ database: made.ref, name: "Owner", type: "text" }));
  const widths = async () =>
    (JSON.parse(await quadit.cli("--json", "doc", made.ref)) as { views: { config?: { widths?: object } }[] }).views[0]
      ?.config?.widths;

  await page.goto(`/e2e/docs/${made.ref}`);
  const handle = page.getByRole("separator", { name: "Resize Owner" });
  const start = Number(await handle.getAttribute("aria-valuenow"));
  // The database's first view is on the server before the change is made.
  await expect
    .poll(async () => (JSON.parse(await quadit.cli("--json", "doc", made.ref)) as { views: unknown[] }).views.length)
    .toBe(1);

  // On this page alone: no write to IndexedDB is made.
  await page.evaluate(() => {
    IDBDatabase.prototype.transaction = () => {
      throw new DOMException("the page is going", "InvalidStateError");
    };
  });
  // The change's request is held on its way and goes with the page; the next page's go through.
  let held = false;
  await page.route("**/changes?events=1", async (route) => {
    if (held) return route.continue();
    held = true;
  });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(start + 10));
  await page.reload();

  await expect.poll(async () => Object.values((await widths()) ?? {})).toEqual([start + 10]);
  await expect(handle).toHaveAttribute("aria-valuenow", String(start + 10));
});

test("a task opened while the server cannot be reached says that it waits, and loads by itself once it can", async ({
  page,
  context,
  project,
  quadit,
}) => {
  const other = await project.newTask("Mow the lawn");
  const key = await project.newTask("Paint the fence");
  await quadit.cli("comment", key, "Two coats, the second on Friday.");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const row = page.getByRole("link", { name: `Open ${key}` });
  await expect(row).toBeVisible();
  // The page has shown a task before, so what it needs to show one is already loaded.
  await page.getByRole("link", { name: `Open ${other}` }).click();
  await expect(
    page.getByRole("complementary", { name: other }).getByRole("heading", { name: "Activity" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: other })).toBeHidden();

  await context.setOffline(true);
  await row.click();
  const task = page.getByRole("complementary", { name: key });
  await expect(task.getByText("Waiting for a connection. The rest loads by itself")).toBeVisible();

  await context.setOffline(false);
  await expect(task.getByText("Two coats, the second on Friday.")).toBeVisible({ timeout: 15_000 });
  await expect(task.getByText("Waiting for a connection")).toBeHidden();
});

// A phone that slept, a tunnel that came back without its connections: the
// request goes out and nothing ever comes back, not even an error.
test("a task whose requests get no answer at all is asked for again, and loads", async ({ page, project, quadit }) => {
  const key = await project.newTask("Sand the table");
  await quadit.cli("comment", key, "Start with the coarse paper.");
  await page.clock.install();
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const row = page.getByRole("link", { name: `Open ${key}` });
  await expect(row).toBeVisible();

  // The first request for the task's contents is never answered; those after it are.
  let lost = 0;
  await page.route(/\/tasks\/[^/?]+\?raw=1$/, (route) => (lost++ === 0 ? undefined : route.continue()));
  await row.click();
  const task = page.getByRole("complementary", { name: key });
  await expect(task.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect.poll(() => lost).toBe(1);
  await expect(task.getByText("Start with the coarse paper.")).toBeHidden();

  // Given up after twenty seconds, then asked for again.
  await page.clock.fastForward(21_000);
  await page.clock.fastForward(2000);
  await expect(task.getByText("Start with the coarse paper.")).toBeVisible({ timeout: 15_000 });
  expect(lost).toBe(2);
});
