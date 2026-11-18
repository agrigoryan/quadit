import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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

test("an agent's weekly hand-off limit is set when it is made, and taken off on its page", async ({ page }) => {
  const name = unique("Courier");
  await page.goto("/e2e/settings/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  const form = page.getByRole("dialog", { name: "New agent" });
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await form.getByRole("textbox", { name: "Hand-offs per week" }).fill("3");
  await form.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  const limit = page.getByRole("textbox", { name: "Hand-offs per week" });
  await expect(limit).toHaveValue("3");
  await page.reload();
  await expect(limit).toHaveValue("3");

  await limit.fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await expect
    .poll(async () => {
      await page.reload();
      return limit.inputValue();
    })
    .toBe("");
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
  // The list is on screen before the browser goes away: what is checked is that it catches up, not that a
  // first read held up by the outage gets through in the end.
  const listed = page.waitForResponse((r) => r.request().method() === "GET" && r.url().endsWith("/w/e2e/tokens"));
  await page.goto("/e2e/settings/me/tokens");
  expect((await listed).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "New token" })).toBeVisible();

  await context.setOffline(true);
  await page.waitForFunction(() => !navigator.onLine);
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

// Every set of choices drawn as buttons is a radio group (ui/radio-group.tsx):
// one Tab stop, the arrows move and pick, Home and End go to the ends.
test("the import source is picked from the keyboard", async ({ page }) => {
  await page.goto("/e2e/settings/import");
  const sources = page.getByRole("radiogroup", { name: "Where from" });
  const source = (name: string) => sources.getByRole("radio", { name: new RegExp(`^${name}`) });
  await source("Linear").click();
  await expect(source("Linear")).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(source("Asana")).toBeFocused();
  await expect(source("Asana")).toBeChecked();
  await page.keyboard.press("End");
  await expect(source("Orbit")).toBeFocused();
  await expect(source("Orbit")).toBeChecked();
  // Round the ends, both ways. (The focus moves a moment after the key: the next key waits for it, as a person does.)
  await page.keyboard.press("ArrowDown");
  await expect(source("Linear")).toBeFocused();
  await expect(source("Linear")).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(source("Orbit")).toBeFocused();
  await expect(source("Orbit")).toBeChecked();
  await page.keyboard.press("Home");
  await expect(source("Linear")).toBeFocused();
  await expect(source("Linear")).toBeChecked();
  await expect(source("Asana")).not.toBeChecked();
});

// A zip of a folder says nothing about where it came from, so its import is
// named: the name, not the zip's file name, is what an import made again goes on.
test("a folder's import is named before it runs", async ({ page }) => {
  await page.goto("/e2e/settings/import");
  await page
    .getByRole("radiogroup", { name: "Where from" })
    .getByRole("radio", { name: /^Markdown files/ })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles(fileURLToPath(new URL("files/handbook.zip", import.meta.url)));
  await expect(page.getByText("Uploaded")).toBeVisible();

  const name = page.getByRole("textbox", { name: "Name of this import" });
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByText("Name this import")).toBeVisible();
  await name.fill(unique("handbook"));
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByText("Found 1 page.")).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("Imported 1 page.")).toBeVisible();
});

// A field's message is about what was in the field: editing the field takes it
// away; the next try that is refused the same way shows it again.
test("a field's message goes once the field is edited", async ({ page }) => {
  await page.goto("/e2e/settings/projects");
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  const name = dialog.getByRole("textbox", { name: "Name" });
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("This is required");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await name.fill("Zeta");
  await expect(dialog.getByRole("alert")).toBeHidden();
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await name.fill("");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("This is required");
});
