// First-run setup: shown at the first start instead of the server list,
// its steps in order, and not again once closed.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desktop, expect, test } from "./desktop";

test("setup opens at the first start with its steps in order, and not at the next", async ({ run }) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  let desktop = await Desktop.launch(data, run, [], { firstStart: true });
  try {
    const setup = await desktop.appPage("setup.html");
    await expect(setup.getByRole("heading", { level: 2 })).toHaveText([
      "1. Add your server",
      "2. Sign in",
      "3. Notifications",
      "4. Connect your agents",
      "5. Quick capture",
    ]);
    await expect(setup.getByRole("checkbox", { name: /quick capture/ })).toBeChecked();
    await setup.getByRole("button", { name: "Done" }).click();
    await expect.poll(() => JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).setupDone).toBe(true);
  } finally {
    await desktop.close();
  }

  desktop = await Desktop.launch(data, run);
  try {
    await desktop.serverList();
    expect(desktop.app.windows().some((page) => page.url().endsWith("setup.html"))).toBe(false);
  } finally {
    await desktop.close();
  }
});

test("setup opens again from the app menu", async ({ desktop }) => {
  await desktop.chooseMenuItem("setup");
  await desktop.appPage("setup.html");
});
