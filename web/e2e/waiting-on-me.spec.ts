// Filter → Waiting on → Me: "me" in the address and in a view saved with
// it, which shows each reader what waits on them.

import { expect, test } from "./quadit";
import { AGENT, OWNER, WORKSPACE } from "./run";

test("a view saved with Waiting on: Me shows each reader what waits on them", async ({ page, project, quadit }) => {
  const mine = await project.newTask("Approve the sprite sheet", `waiting_on=@${OWNER.handle}`);
  const theirs = await project.newTask("Fix the jump", `waiting_on=@${AGENT.handle}`);

  await page.goto(`/${WORKSPACE.slug}/p/${project.key}/tasks`);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("option", { name: "Waiting on" }).click();
  await expect(page.getByRole("option").first()).toHaveAccessibleName("Me");
  await page.getByRole("option", { name: "Me", exact: true }).click();
  await expect(page).toHaveURL(/[?&]waiting_on=me(&|$)/);
  await expect(page.getByRole("link", { name: `Open ${mine}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${theirs}` })).toHaveCount(0);

  await page.getByRole("button", { name: "Save as view" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(`Waiting on me ${project.key}`);
  await page.getByRole("dialog").getByRole("button", { name: "Save as view" }).click();
  await expect(page).toHaveURL(new RegExp(`/${WORKSPACE.slug}/view/`));
  // The view reads as it was saved: Waiting on, Me.
  await expect(page.getByRole("button", { name: /^Waiting on\s*.*Me$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: `Open ${mine}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${theirs}` })).toHaveCount(0);
  const slug = new URL(page.url()).pathname.split("/view/")[1] ?? "";

  // The agent runs the same view and gets what waits on it.
  const forAgent = await quadit.agent("tasks", `view=${slug}`);
  expect(forAgent).toContain(theirs);
  expect(forAgent).not.toContain(mine);
  const forOwner = await quadit.cli("tasks", `view=${slug}`);
  expect(forOwner).toContain(mine);
  expect(forOwner).not.toContain(theirs);
});
