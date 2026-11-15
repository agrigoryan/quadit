import type { Page } from "@playwright/test";
import { expect, test } from "./quadit";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Nothing runs off the side of the screen: the page does not scroll sideways. */
async function fitsTheWidth(page: Page) {
  const [content, screen] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(content).toBeLessThanOrEqual(screen);
}

test("on a phone the task list, a task page and the sidebar drawer work", async ({ page, project, quadit }) => {
  const key = await project.newTask("Water the plants");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const row = page.getByRole("link", { name: `Open ${key}` });
  await expect(row).toBeVisible();
  await fitsTheWidth(page);
  // The toolbar shows icons only here; they keep their names.
  await expect(page.getByRole("tab", { name: "List", selected: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Board" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as view" })).toBeVisible();

  // The sidebar is a drawer here. Every project in it has its own "Tasks" and "Board", in a list named after the project.
  const sidebar = page.getByRole("navigation", { name: "Main" });
  const place = (name: string) =>
    sidebar.getByRole("list", { name: project.name, exact: true }).getByRole("link", { name, exact: true });
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).tap();
  await expect(sidebar).toBeVisible();
  await place("Board").tap();
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project.key}/board$`));
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).tap();
  await place("Tasks").tap();
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project.key}/tasks$`));

  // The task opens over the list, as a sheet.
  await row.tap();
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${key}$`));
  const task = page.getByRole("complementary", { name: key });
  await expect(task.getByRole("textbox", { name: "Title" })).toHaveValue("Water the plants");
  const properties = task.getByRole("region", { name: "Properties" });
  await properties.getByRole("button", { name: "Status: Todo" }).tap();
  await page.getByRole("option", { name: "Done" }).tap();
  await expect(properties.getByRole("button", { name: "Status: Done" })).toBeVisible();
  await expect.poll(async () => (await quadit.task(key)).status).toBe("Done");
  await fitsTheWidth(page);
});
