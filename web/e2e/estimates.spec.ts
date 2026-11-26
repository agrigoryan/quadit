// Estimates as a project has them: a scale picked in its settings, an
// estimate picked from it with Shift+E and shown as a size on a T-shirt
// project, a zero estimate kept apart from none, and the list filtered by
// estimate. What reached the server is read back through the CLI.

import { expect, type Quadit, test } from "./quadit";

/** The task's estimate as the server has it; undefined for none. */
async function estimateOf(quadit: Quadit, key: string): Promise<number | undefined> {
  const { task } = JSON.parse(await quadit.cli("--json", "show", key)) as { task: { estimate?: number } };
  return task.estimate;
}

/** Sets the project's settings as an admin would, through the CLI. */
const settle = (quadit: Quadit, key: string, settings: object) =>
  quadit.cli("do", "project.update", JSON.stringify({ id: key, settings }));

test("a scale picked in the project's settings is kept, with its options", async ({ page, project, quadit }) => {
  await page.goto(`/e2e/settings/projects/${project.key}/general`);
  await page.getByRole("switch", { name: /^Estimates/ }).click();
  const scale = page.getByRole("combobox", { name: "Scale" });
  // Turned on with no scale named, it is Fibonacci.
  await expect(scale).toHaveValue("fibonacci");
  await scale.selectOption({ label: "T-shirt: XS, S, M, L, XL" });
  await page.getByRole("switch", { name: /^Extended scale/ }).click();
  await page.getByRole("switch", { name: /^Zero estimates/ }).click();

  // What an agent is told the project takes.
  const layout = async () =>
    (JSON.parse(await quadit.cli("--json", "layout", project.key)) as { project: { estimates?: object } }).project
      .estimates;
  await expect.poll(layout).toMatchObject({ scale: "tshirt", values: [0, 1, 2, 3, 5, 8, 13, 21] });
  await page.reload();
  await expect(scale).toHaveValue("tshirt");
  await expect(page.getByRole("switch", { name: /^Extended scale/ })).toBeChecked();
  await expect(page.getByRole("switch", { name: /^Count a task without an estimate as 1 point/ })).toBeChecked();
});

test("Shift+E picks an estimate from the keyboard, and a T-shirt project shows its size", async ({
  page,
  project,
  quadit,
}) => {
  await settle(quadit, project.key, { estimates: true, estimate_scale: "tshirt" });
  const key = await project.newTask("Redraw the tide chart");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  const open = page.getByRole("link", { name: `Open ${key}` });
  await expect(open).toBeVisible();
  await page.keyboard.press("j");
  await expect(open).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("Shift+E");
  const list = page.getByRole("dialog", { name: "Set estimate…" });
  // The letter is not typed into the search.
  await expect(list.getByRole("combobox")).toHaveValue("");
  await page.keyboard.type("xl");
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect.poll(() => estimateOf(quadit, key)).toBe(8);

  const row = page.locator("[data-task]", { has: open });
  await expect(row.getByTitle("Estimate: XL").getByText("XL", { exact: true })).toBeVisible();
  await page.keyboard.press(" ");
  const panel = page.getByRole("complementary", { name: key });
  await expect(panel.getByRole("button", { name: "Estimate: XL" })).toBeVisible();
});

test("a zero estimate is kept apart from no estimate", async ({ page, project, quadit }) => {
  await settle(quadit, project.key, { estimates: true, estimate_scale: "fibonacci", estimate_zero: true });
  const key = await project.newTask("Rename a label");
  await page.goto(`/e2e/task/${key}`);
  const row = page.getByRole("button", { name: "Estimate: No estimate" });
  await expect(row).toBeVisible();

  await page.keyboard.press("Shift+E");
  await page.getByRole("dialog", { name: "Set estimate…" }).getByRole("option", { name: "0 points" }).click();
  await expect(page.getByRole("button", { name: "Estimate: 0 points" })).toBeVisible();
  await expect.poll(() => estimateOf(quadit, key)).toBe(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Estimate: 0 points" })).toBeVisible();

  await page.getByRole("button", { name: "Estimate: 0 points" }).click();
  await page.getByRole("dialog", { name: "Set estimate…" }).getByRole("option", { name: "No estimate" }).click();
  await expect(row).toBeVisible();
  await expect.poll(() => estimateOf(quadit, key)).toBeUndefined();
});

test("the list is filtered by estimate, and the address keeps it", async ({ page, project, quadit }) => {
  await settle(quadit, project.key, { estimates: true, estimate_scale: "fibonacci" });
  const small = await project.newTask("Fix the typo", "estimate=1");
  const big = await project.newTask("Rewrite the sync", "estimate=8");
  const unsized = await project.newTask("Look into the crash");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  for (const key of [small, big, unsized]) await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("dialog", { name: "Filter" }).getByRole("option", { name: "Estimate", exact: true }).click();
  const values = page.getByRole("dialog", { name: "Estimate" });
  await values.getByRole("option", { name: "8 points" }).click();
  await values.getByRole("option", { name: "No estimate" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: `Open ${small}` })).toBeHidden();
  await expect(page.getByRole("link", { name: `Open ${big}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${unsized}` })).toBeVisible();
  await expect(page).toHaveURL(/[?&]estimate=8(,|%2C)none/);

  // An address written by hand: a size names its number on any project.
  await page.goto(`/e2e/p/${project.key}/tasks?estimate=XS`);
  await expect(page.getByRole("link", { name: `Open ${small}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${big}` })).toBeHidden();
  await expect(page.getByRole("link", { name: `Open ${unsized}` })).toBeHidden();
});
