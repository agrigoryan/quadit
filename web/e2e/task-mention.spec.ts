import { expect, test } from "./quadit";

// A task named in a comment shows the task as it stands (its status, kept
// current by the feed), a card about it when the pointer rests on it, and
// still opens the task when clicked.
test("a task named in a comment shows its status as it changes, a card about it, and opens it", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Boss fight");
  const other = await project.newTask("Arena lighting", "assignee=@coder");
  await quadit.agent("comment", key, `Waits on ${other} first.`);
  const { status } = await quadit.task(other);

  await page.goto(`/e2e/task/${key}`);
  const comment = page.getByRole("region", { name: "Activity" }).getByRole("listitem").filter({ hasText: "Waits on" });
  const mention = comment.getByRole("link", { name: new RegExp(`${other} Arena lighting`) });
  await expect(mention.getByRole("img", { name: status })).toBeVisible();

  await mention.hover();
  const card = page.getByRole("tooltip");
  await expect(card.getByText("Arena lighting")).toBeVisible();
  await expect(card.getByText("Coder")).toBeVisible();
  await expect(card.getByText(status, { exact: true })).toBeVisible();

  // Changed elsewhere, the status shows on the mention and in the card.
  await quadit.agent("update", other, "status=In Progress");
  await expect(mention.getByRole("img", { name: "In Progress" })).toBeVisible();
  await expect(card.getByText("In Progress", { exact: true })).toBeVisible();

  await mention.click();
  await expect(card).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${other}$`));
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Arena lighting");
});
