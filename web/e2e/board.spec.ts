import { expect, test } from "./quadit";

// The keyboard path (Shift+Space lifts, the arrows move, Space drops): it is
// what a person without a mouse uses, and it does not depend on pointer timing.
test("a card moves to the next column from the keyboard", async ({ page, project, quadit }) => {
  const key = await project.newTask("Paint the fence");
  await page.goto(`/e2e/p/${project.key}/board`);
  const card = (column: string) =>
    page.getByRole("region", { name: column, exact: true }).getByRole("link", { name: new RegExp(`${key} Paint`) });
  await expect(card("Todo")).toBeVisible();

  await card("Todo").focus();
  await page.keyboard.press("Shift+Space");
  await expect(page.getByRole("main").getByRole("status")).toHaveText(/Picked up|moved over/);
  // While lifted the card is drawn in the column it is over. dnd-kit measures
  // the columns after the lift, and an arrow pressed before that is lost (a
  // person presses it again), so the arrow is pressed until the card is across.
  await expect(async () => {
    if ((await card("In Progress").count()) === 0) await page.keyboard.press("ArrowRight");
    await expect(card("In Progress")).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.keyboard.press("Space");
  await expect.poll(async () => (await quadit.task(key)).status).toBe("In Progress");
  await page.reload();
  await expect(card("In Progress")).toBeVisible();
  await expect(card("Todo")).toBeHidden();
});
