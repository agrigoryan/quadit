import { randomUUID } from "node:crypto";
import { currentRun, OWNER, quadit } from "./run";
import { expect, test } from "./quadit";

// Each test names what it makes with a word of its own, so it can run again on the same server.
const unique = (name: string) => `${name} ${randomUUID().slice(0, 8)}`;

test("an API token is shown once and works", async ({ page }) => {
  const tokenName = unique("deploy bot");
  await page.goto("/e2e/settings/me/tokens");
  await page.getByRole("button", { name: "New token" }).click();
  const form = page.getByRole("dialog", { name: "New API token" });
  await form.getByRole("textbox", { name: "Name" }).fill(tokenName);
  await form.getByRole("button", { name: "Create token" }).click();

  const shown = page.getByRole("dialog", { name: `Token “${tokenName}”` });
  await expect(shown.getByText("It is shown this once")).toBeVisible();
  const token = (await shown.getByRole("code").first().textContent()) ?? "";
  expect(token).toMatch(/^qd_/);
  expect(await quadit(currentRun(), token, ["me"])).toContain(`you are @${OWNER.handle}`);

  await shown.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("main").getByText(tokenName)).toBeVisible();
  await expect(page.getByText(token)).toBeHidden();
});

test("the workspace is renamed", async ({ page }) => {
  const newName = unique("E2E");
  await page.goto("/e2e/settings/general");
  const name = page.getByRole("textbox", { name: "Workspace name" });
  await expect(name).toHaveValue(/.+/);
  await name.fill(newName);
  await page.getByRole("button", { name: "Save" }).click();
  const switcher = page.getByRole("button", { name: "Switch workspace" });
  await expect(switcher).toContainText(newName);
  await page.reload();
  await expect(name).toHaveValue(newName);
  await expect(switcher).toContainText(newName);
});

test("the API tokens list catches up after the browser was offline, without a reload", async ({
  page,
  context,
  request,
}) => {
  const run = currentRun();
  const tokenName = unique("made while away");
  await page.goto("/e2e/settings/me/tokens");
  await expect(page.getByRole("button", { name: "New token" })).toBeVisible();

  await context.setOffline(true);
  // Made elsewhere while this browser cannot hear of it. A token is not an event: only asking again shows it.
  const made = await request.post(`${run.url}/api/v1/w/e2e/tokens`, {
    headers: { Authorization: `Bearer ${run.token}` },
    data: { user: "me", name: tokenName, read_only: true, projects: [], expires_days: 30 },
  });
  expect(made.ok()).toBe(true);
  await expect(page.getByRole("main").getByText(tokenName)).toBeHidden();

  await context.setOffline(false);
  await expect(page.getByRole("main").getByText(tokenName)).toBeVisible({ timeout: 15_000 });
});
