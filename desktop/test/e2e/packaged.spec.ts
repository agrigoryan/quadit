import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desktop, expect, test } from "./desktop";

/** The app electron-builder made (pnpm dist), for this Mac's architecture. */
const PACKAGED = join(
  __dirname,
  "../../dist",
  process.arch === "arm64" ? "mac-arm64" : "mac",
  "Quadit.app/Contents/MacOS/Quadit",
);

test("the packaged app starts, adds a server and gives its pages the bridge", async ({ run }) => {
  test.skip(process.platform !== "darwin" || !existsSync(PACKAGED), "no packaged app: run pnpm dist first");
  const desktop = await Desktop.launch(mkdtempSync(join(tmpdir(), "quadit-desktop-packaged-")), run, {
    executable: PACKAGED,
  });
  try {
    expect(
      await desktop.app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        name: app.name,
        version: app.getVersion(),
      })),
    ).toEqual({
      packaged: true,
      name: "Quadit",
      version: "0.1.0",
    });
    const list =
      desktop.app.windows().find((page) => page.url().endsWith("/out/pages/servers.html")) ??
      (await desktop.app.waitForEvent("window"));
    await expect(list.getByRole("heading", { name: "Quadit" })).toBeVisible();
    await list.getByLabel("Address").fill(run.server);
    await list.getByRole("button", { name: "Add server" }).click();
    await desktop.pageOf(run.server);
    const page = await desktop.signedIn(run.server);
    expect(await page.evaluate(() => window.quaditDesktop?.version)).toBe("0.1.0");
    // No developer tools in the menu of a packaged app.
    const roles = await desktop.app.evaluate(({ Menu }) => {
      const walk = (items: Electron.MenuItem[]): string[] =>
        items.flatMap((item) => [item.role ?? "", ...walk(item.submenu?.items ?? [])]);
      return walk(Menu.getApplicationMenu()?.items ?? []);
    });
    expect(roles).not.toContain("toggledevtools");
    expect(roles).toContain("selectall");
  } finally {
    await desktop.close();
  }
});
