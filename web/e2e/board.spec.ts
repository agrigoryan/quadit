import type { Page } from "@playwright/test";
import { expect, test } from "./quadit";

/** A task's card in a column of the board, by the task's key. */
const cardIn = (page: Page, column: string, key: string) =>
  page.getByRole("region", { name: column, exact: true }).getByRole("link", { name: new RegExp(`${key} `) });

/**
 * Lifts the card with Shift+Space, moves it with the arrow to the column
 * beside, and drops it with Space, reading what a screen reader is told.
 */
async function moveAcross(page: Page, key: string, title: string, from: string, to: string, arrow: string) {
  await cardIn(page, from, key).focus();
  await page.keyboard.press("Shift+Space");
  const said = page.getByRole("main").getByRole("status");
  await expect(said).toHaveText(`Picked up ${key} ${title} in ${from}.`);
  // While lifted the card is drawn in the column it is over. dnd-kit measures
  // the columns after the lift, and an arrow pressed before that is lost (a
  // person presses it again), so the arrow is pressed until the card is across.
  await expect(async () => {
    if ((await cardIn(page, to, key).count()) === 0) await page.keyboard.press(arrow);
    await expect(cardIn(page, to, key)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(said).toHaveText(`${key} ${title} is over ${to}.`);
  await page.keyboard.press("Space");
  await expect(said).toHaveText(`${key} ${title} dropped in ${to}.`);
}

// The keyboard path (Shift+Space lifts, the arrows move, Space drops): it is
// what a person without a mouse uses, and it does not depend on pointer timing.
// The card moved is the middle one of three, so the column it leaves is not empty.
test("a card moves to the next column and back from the keyboard", async ({ page, project, quadit }) => {
  const above = await project.newTask("Buy the paint");
  const key = await project.newTask("Paint the fence");
  const below = await project.newTask("Clean the brushes");
  await page.goto(`/e2e/p/${project.key}/board`);
  for (const k of [above, key, below]) await expect(cardIn(page, "Todo", k)).toBeVisible();

  await moveAcross(page, key, "Paint the fence", "Todo", "In Progress", "ArrowRight");
  await expect.poll(async () => (await quadit.task(key)).status).toBe("In Progress");
  await page.reload();
  await expect(cardIn(page, "In Progress", key)).toBeVisible();
  await expect(cardIn(page, "Todo", key)).toBeHidden();

  await moveAcross(page, key, "Paint the fence", "In Progress", "Todo", "ArrowLeft");
  await expect.poll(async () => (await quadit.task(key)).status).toBe("Todo");
  for (const k of [above, below]) expect((await quadit.task(k)).status).toBe("Todo");
});

// The server moves every task of a deleted status, those in the trash too; the
// dialog asks where before the first try, though the column shows no card.
test("a status whose only task is in the trash is deleted once its tasks have a place", async ({
  page,
  project,
  quadit,
}) => {
  await quadit.cli(
    "do",
    "status.create",
    JSON.stringify({ project: project.key, name: "Polish", category: "started" }),
  );
  const key = await project.newTask("Sand the edges", "status=Polish");
  await quadit.cli("delete", key);
  await page.goto(`/e2e/p/${project.key}/board`);
  await page.getByRole("button", { name: "Status options: Polish" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete the status “Polish”?" });
  await expect(dialog.getByText("That counts one task in the trash, which moves too.")).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Move its tasks to" })).toBeVisible();
  await dialog.getByRole("button", { name: "Move tasks and delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Polish", exact: true })).toBeHidden();
  await quadit.cli("restore", key);
  await expect.poll(async () => (await quadit.task(key)).status).toBe("In Progress");
});
