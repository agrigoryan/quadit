import { expect, test } from "./desktop";
import { quadit } from "./run";

test("a server's pages cannot read the clipboard by themselves, and Paste still pastes into fields and the editor", async ({
  desktop,
  run,
}) => {
  const project = `C${Date.now().toString(36).toUpperCase().slice(-5)}`;
  await quadit(run, ["do", "project.create", JSON.stringify({ key: project, name: `Clipboard ${project}` })]);
  const key = (JSON.parse(await quadit(run, ["--json", "new", project, "Renew the certificate"])) as { key: string })
    .key;
  const doc = (
    JSON.parse(
      await quadit(run, [
        "--json",
        "do",
        "doc.create",
        JSON.stringify({ title: "Runbook", project, markdown: "Steps first.\n" }),
      ]),
    ) as { ref: string }
  ).ref;
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await desktop.app.evaluate(async ({ BrowserWindow, clipboard }, origin) => {
    await clipboard.writeText(" and a copied secret");
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith(origin))
      ?.focus();
  }, run.server);

  // Asked, the app says no; a script reading it is refused.
  expect(
    await page.evaluate(
      async () => (await navigator.permissions.query({ name: "clipboard-read" as PermissionName })).state,
    ),
  ).toBe("denied");
  expect(await page.evaluate(() => navigator.clipboard.readText().then(String, () => "refused"))).toBe("refused");

  /** The Edit menu's Paste (and Cmd+V, which is its key) on the window. */
  const paste = () =>
    desktop.app.evaluate(({ BrowserWindow }, origin) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith(origin))
        ?.webContents.paste();
    }, run.server);

  // A text field.
  await page.goto(`${run.server}/e2e/task/${key}`);
  const title = page.getByRole("textbox", { name: "Title" });
  await title.click();
  await page.keyboard.press("End");
  await paste();
  await expect(title).toHaveValue("Renew the certificate and a copied secret");

  // The page editor.
  await page.goto(`${run.server}/e2e/docs/${doc}`);
  const text = page.getByRole("textbox", { name: "Page text" });
  await text.getByText("Steps first.").click();
  await paste();
  await expect(text).toContainText("and a copied secret");
});
