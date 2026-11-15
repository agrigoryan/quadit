// A member whose access is read-only may look and change nothing: the server
// refuses every change from them, so the app offers no control that makes one.

import type { APIRequestContext, Browser } from "@playwright/test";
import { currentRun, WORKSPACE } from "./run";
import { expect, type Project, type Quadit, test } from "./quadit";

/**
 * A new person, invited by the owner as a member, made read-only, and
 * signed in in a browser of their own. `owner` is the owner's signed-in page's requests.
 */
async function readOnlyMember(browser: Browser, owner: APIRequestContext, quadit: Quadit, project: Project) {
  const invite = await owner.post(`/api/v1/w/${WORKSPACE.slug}/invites`, { data: { role: "member" } });
  expect(invite.ok()).toBe(true);
  const { link } = (await invite.json()) as { link: string };

  const context = await browser.newContext({
    baseURL: currentRun().url,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
  });
  const accepted = await context.request.post(`/api/v1/auth/invite/${link.slice(link.lastIndexOf("/") + 1)}`, {
    data: {
      name: `Reader ${project.key}`,
      email: `reader-${project.key.toLowerCase()}@example.com`,
      password: "a-long-reader-password",
    },
  });
  expect(accepted.ok()).toBe(true);
  const { user } = (await accepted.json()) as { user: { id: string } };
  await quadit.cli("do", "member.update", JSON.stringify({ id: user.id, scope: { read_only: true } }));
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
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue("Read the contract");
  await expect(title).not.toBeEditable();
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
