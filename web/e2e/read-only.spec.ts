// A member whose access is read-only may look and change nothing: the server
// refuses every change from them, so the app offers no control that makes one.

import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, invitedMember, type Project, type Quadit, test } from "./quadit";

/**
 * A new person, invited by the owner as a member, made read-only, and
 * signed in in a browser of their own. `owner` is the owner's signed-in page's requests.
 */
async function readOnlyMember(browser: Browser, owner: APIRequestContext, quadit: Quadit, project: Project) {
  const { context, userID } = await invitedMember(browser, owner, `Reader ${project.key}`);
  await quadit.cli("do", "member.update", JSON.stringify({ id: userID, scope: { read_only: true } }));
  return context;
}

test("a read-only member sees a task but no control that changes it, and cannot make one", async ({
  browser,
  page: ownerPage,
  project,
  quadit,
}) => {
  const key = await project.newTask("Read the contract");
  const context = await readOnlyMember(browser, ownerPage.request, quadit, project);
  const page = await context.newPage();

  await page.goto(`/e2e/task/${key}`);
  await expect(page.getByRole("heading", { level: 2, name: "Read the contract" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
  const properties = page.getByRole("region", { name: "Properties" });
  await expect(properties.getByRole("button", { name: "Status: Todo" })).toBeDisabled();
  await expect(properties.getByRole("button", { name: "Assignee: Unassigned" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "New comment" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Sub-task" })).toBeHidden();

  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("button", { name: "New task" })).toBeHidden();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "New task" })).toBeHidden();

  await context.close();
});

// A board card's avatar is a button of its own, beside the link that opens
// the task: it picks an assignee for someone who may change the task, and
// tells a read-only member about the assignee instead.
test("a board card's avatar opens the assignee picker, or for a read-only member the card about the assignee", async ({
  browser,
  page: ownerPage,
  project,
  quadit,
}) => {
  const key = await project.newTask("Paint the gate", "assignee=@coder");
  const card = (page: Page) =>
    page
      .getByRole("region", { name: "Todo", exact: true })
      .getByRole("article")
      .filter({
        has: page.getByRole("link", { name: `${key} Paint the gate` }),
      });

  await ownerPage.goto(`/e2e/p/${project.key}/board`);
  await card(ownerPage).getByRole("button", { name: "Assignee: Coder" }).click();
  await expect(ownerPage.getByRole("dialog", { name: "Assign to…" })).toBeVisible();
  await expect(ownerPage).toHaveURL(new RegExp(`/e2e/p/${project.key}/board$`));

  const context = await readOnlyMember(browser, ownerPage.request, quadit, project);
  const page = await context.newPage();
  await page.goto(`/e2e/p/${project.key}/board`);
  await expect(card(page).getByRole("button", { name: /^Assignee/ })).toHaveCount(0);
  await card(page).getByRole("button", { name: "About Coder" }).click();
  const about = page.getByRole("dialog", { name: "Coder" });
  await expect(about).toBeVisible();
  await expect(about.getByText("@coder · Agent")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project.key}/board$`));
  // Anywhere else on the card still opens the task: its corner, away from the title.
  await page.keyboard.press("Escape");
  await expect(about).toBeHidden();
  await card(page).click({ position: { x: 4, y: 4 } });
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${key}$`));
  await context.close();
});
