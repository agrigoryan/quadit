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
