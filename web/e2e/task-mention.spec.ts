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

// A task moved to another project takes a new key; text written before still
// names it by the old one, and so may a link someone kept.
test("a task named by the key it had before it moved shows and opens it under its new key", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Boss fight");
  const moving = await project.newTask("Arena lighting");
  await quadit.agent("comment", key, `Waits on ${moving} first.`);
  const made = JSON.parse(
    await quadit.cli(
      "--json",
      "do",
      "doc.create",
      JSON.stringify({ title: "Plan", project: project.key, markdown: `Light ${moving} first.\n` }),
    ),
  ) as { ref: string };
  const other = `${project.key}X`;
  await quadit.cli("do", "project.create", JSON.stringify({ key: other, name: `Elsewhere ${other}` }));
  await quadit.cli("do", "task.move", JSON.stringify({ id: moving, project: other }));
  const moved = `${other}-1`;

  await page.goto(`/e2e/task/${key}`);
  const comment = page.getByRole("region", { name: "Activity" }).getByRole("listitem").filter({ hasText: "Waits on" });
  const mention = comment.getByRole("link", { name: new RegExp(`${moved} Arena lighting`) });
  await expect(mention).toBeVisible();
  await mention.click();
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${moved}$`));
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Arena lighting");

  // A link kept from before the move goes to the task at its new address.
  await page.goto(`/e2e/task/${moving}`);
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${moved}$`));
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Arena lighting");

  // So does a page that named it.
  await page.goto(`/e2e/docs/${made.ref}`);
  const chip = page.getByText(new RegExp(`${moved}\\s*Arena lighting`));
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${moved}$`));
});
