// A member limited to some projects sees those projects and nothing of the
// others: a task related to one of another project says so, without that
// task's key or title, also when the relation is made while they look.

import { expect, invitedMember, test } from "./quadit";

test("a member limited to one project sees a related task of another project as one they can't see", async ({
  browser,
  page: ownerPage,
  project,
  quadit,
}) => {
  const otherKey = `Q${project.key.slice(1)}`;
  await quadit.cli("do", "project.create", JSON.stringify({ key: otherKey, name: `Project ${otherKey}` }));
  const mine = await project.newTask("Draw the boss");
  const hidden = (JSON.parse(await quadit.cli("--json", "new", otherKey, "Rotate the vault keys")) as { key: string })
    .key;
  await quadit.cli("do", "relation.add", JSON.stringify({ task: mine, type: "blocked_by", other: hidden }));

  const { context, userID } = await invitedMember(browser, ownerPage.request, `Limited ${project.key}`);
  await quadit.cli("do", "member.update", JSON.stringify({ id: userID, scope: { projects: [project.key] } }));
  const page = await context.newPage();

  await page.goto(`/e2e/task/${mine}`);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Draw the boss");
  const blockedBy = page.getByRole("region", { name: "Relations" }).getByRole("list", { name: "Blocked by" });
  await expect(blockedBy.getByText("A task you can't see")).toBeVisible();
  await expect(blockedBy.getByRole("link")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(hidden);
  await expect(page.locator("body")).not.toContainText("Rotate the vault keys");

  // With the page open, a task of the other project is related to theirs, and then no longer:
  // the page follows without a reload, still without the task's key or title.
  const second = (JSON.parse(await quadit.cli("--json", "new", otherKey, "Renew the certificates")) as { key: string })
    .key;
  const relation = (
    JSON.parse(
      await quadit.cli("--json", "do", "relation.add", JSON.stringify({ task: second, type: "blocks", other: mine })),
    ) as { ref: string }
  ).ref;
  await expect(blockedBy.getByText("A task you can't see")).toHaveCount(2);
  await expect(page.locator("body")).not.toContainText(second);
  await expect(page.locator("body")).not.toContainText("Renew the certificates");
  await quadit.cli("do", "relation.remove", JSON.stringify({ id: relation }));
  await expect(blockedBy.getByText("A task you can't see")).toHaveCount(1);

  // The owner, who may read both projects, is shown the task itself.
  await ownerPage.goto(`/e2e/task/${mine}`);
  await expect(
    ownerPage
      .getByRole("region", { name: "Relations" })
      .getByRole("list", { name: "Blocked by" })
      .getByRole("link", { name: "Rotate the vault keys" }),
  ).toBeVisible();

  await context.close();
});
