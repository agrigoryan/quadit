import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "./desktop";
import { quadit } from "./run";

test("a link to another site opens in the system browser, and the window stays on the server", async ({
  desktop,
  run,
}) => {
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  const before = page.url();
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "https://example.com/docs?from=quadit";
    link.textContent = "Elsewhere";
    document.body.append(link);
    link.click();
  });
  await expect.poll(async () => (await desktop.recorded()).opened).toEqual(["https://example.com/docs?from=quadit"]);
  expect(page.url()).toBe(before);
});

test("window.open: the server's own pages open in another app window, other sites in the browser", async ({
  desktop,
  run,
}) => {
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);

  await page.evaluate(() => window.open("https://example.org/elsewhere", "_blank"));
  await expect.poll(async () => (await desktop.recorded()).opened).toEqual(["https://example.org/elsewhere"]);
  await page.evaluate(() => window.open("javascript:alert(1)", "_blank"));

  const opened = desktop.app.waitForEvent("window");
  await page.evaluate(() => window.open("/e2e/settings", "_blank"));
  const child = await opened;
  await expect(child).toHaveURL(`${run.server}/e2e/settings`);
  // Held to the same rules: its own pages get the bridge, and it shares the server's session.
  expect(await child.evaluate(() => window.quaditDesktop?.version)).toBe("0.1.0");
  expect((await desktop.recorded()).opened).toEqual(["https://example.org/elsewhere"]);
});

test("leaving the sign-in page for a sign-in provider starts the browser sign-in instead", async ({ desktop, run }) => {
  test.skip(run.server !== run.fake, "uses the stand-in's provider redirect");
  const page = await desktop.addServer(run.server);
  await expect(page).toHaveURL(/\/login/);
  const connect = expect.stringMatching(new RegExp(`^${run.server}/desktop/connect\\?`));

  // A link straight to the provider…
  await page.evaluate(() => (location.href = "https://accounts.example.com/o/oauth2/auth?client_id=x"));
  await expect.poll(async () => (await desktop.recorded()).opened).toEqual([connect]);
  // …and the server's own provider start, which redirects there.
  await page.evaluate(() => (location.href = "/__fake/provider"));
  await expect.poll(async () => (await desktop.recorded()).opened).toEqual([connect, connect]);

  // The page never left (Playwright's own URL waits on the stopped navigation, so ask the page).
  expect(await page.evaluate(() => location.pathname)).toBe("/login");
});

test("a quadit://open link shows the server's window at the path, from macOS and from a second launch", async ({
  desktop,
  run,
}) => {
  const project = `L${Date.now().toString(36).toUpperCase().slice(-5)}`;
  await quadit(run, ["do", "project.create", JSON.stringify({ key: project, name: `Links ${project}` })]);
  const key = (JSON.parse(await quadit(run, ["--json", "new", project, "Renew the certificate"])) as { key: string })
    .key;

  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await desktop.openLink(
    `quadit://open?server=${encodeURIComponent(run.server)}&path=${encodeURIComponent(`/e2e/task/${key}`)}`,
  );
  await expect(page).toHaveURL(`${run.server}/e2e/task/${key}`);
  await expect(page.getByText("Renew the certificate").first()).toBeVisible();

  // Windows and Linux start the app again with the link; the running one takes it and the new one quits.
  const electronBinary = require("electron") as unknown as string;
  const second = spawn(
    electronBinary,
    [join(__dirname, "../.."), `quadit://open?server=${encodeURIComponent(run.server)}&path=/e2e/my-work`],
    {
      env: { ...process.env, QUADIT_DESKTOP_DATA: desktop.data },
      stdio: "ignore",
    },
  );
  const exited = new Promise<number | null>((done) => second.once("exit", done));
  await expect(page).toHaveURL(`${run.server}/e2e/my-work`);
  expect(await exited).toBe(0);
});

test("a quadit://open link for a server not added yet offers to add it", async ({ desktop, run }) => {
  await desktop.openLink(`quadit://open?server=${encodeURIComponent(run.server)}&path=/e2e/my-work`);
  const list = await desktop.serverList();
  await expect(list.getByRole("status")).toHaveText(
    new RegExp(`A link asked to open ${run.server.replace(/[.]/g, "\\.")}`),
  );
  await expect(list.getByLabel("Address")).toHaveValue(run.server);
});
