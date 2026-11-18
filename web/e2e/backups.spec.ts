// Backups copied off the machine: an install admin picks a folder on the
// server for every backup to be copied to, backs up, and sees the archive's
// copy marked as there, and it is there.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./quadit";
import { currentRun, fromOwnPage } from "./run";

test("a backup is copied to a folder on the server, and its archive says so", async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), "quadit-copies-"));
  try {
    await page.goto("/admin/backups");
    await page.getByLabel("Also copy each backup to").selectOption("folder");
    await page.getByRole("textbox", { name: "Folder" }).fill(folder);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    await page.getByRole("button", { name: "Back up now" }).click();
    await expect.poll(() => readdirSync(folder)).toHaveLength(1);
    const [copy] = readdirSync(folder);
    const archive = page.getByText(copy ?? "", { exact: true }).locator("xpath=ancestor::div[1]");
    await expect(archive.getByText("Copied", { exact: true })).toBeVisible();
  } finally {
    // The setting is the install's: put it back for whatever runs next.
    const reset = await page.request.put("/api/v1/admin/settings/backup", {
      headers: { ...fromOwnPage(currentRun().url), "Content-Type": "application/json" },
      data: "null",
    });
    expect(reset.ok()).toBe(true);
    rmSync(folder, { recursive: true });
  }
});
