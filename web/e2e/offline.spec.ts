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
