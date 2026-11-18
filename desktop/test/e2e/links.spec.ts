import { spawn } from "node:child_process";
import { join } from "node:path";
import { APP_VERSION, expect, test } from "./desktop";
import type { HandoffEvent } from "./handoff-fake";
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
  // The inbox, which stays at its address: settings moves on to its first section, which a check can catch either side of.
  await page.evaluate(() => window.open("/e2e/inbox", "_blank"));
  const child = await opened;
  await expect(child).toHaveURL(`${run.server}/e2e/inbox`);
  // Held to the same rules: its own pages get the bridge, and it shares the server's session.
  expect(await child.evaluate(() => window.quaditDesktop?.version)).toBe(APP_VERSION);
  expect((await desktop.recorded()).opened).toEqual(["https://example.org/elsewhere"]);
});

test("leaving the sign-in page for a sign-in provider starts the browser sign-in instead", async ({ desktop, run }) => {
  // The stand-in, for its provider start (/__fake/provider).
  const page = await desktop.addServer(run.fake);
  await expect(page).toHaveURL(/\/login/);
  const connect = expect.stringMatching(new RegExp(`^${run.fake}/desktop/connect\\?`));

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

test("a quadit://open link for a server the app is not connected to is refused, and nothing is added", async ({
  desktop,
  run,
}) => {
  await desktop.openLink(`quadit://open?server=${encodeURIComponent(run.server)}&path=/e2e/my-work`);
  await expect
    .poll(async () => (await desktop.recorded()).dialogs)
    .toContainEqual(expect.stringContaining(`This app is not connected to ${run.server}`));
  // Answered Cancel: the server list (open at the first start) makes no offer, and no server window opens.
  const list = await desktop.serverList();
  await expect(list.getByRole("status")).toBeHidden();
  await expect(list.getByLabel("Address")).toHaveValue("");
  expect(desktop.app.windows().some((page) => page.url().startsWith(run.server))).toBe(false);
});

test("a quadit://open link for a server not added yet offers to add it once the person says Add It…", async ({
  desktop,
  run,
}) => {
  await desktop.answerNextDialog(0);
  await desktop.openLink(`quadit://open?server=${encodeURIComponent(run.server)}&path=/e2e/my-work`);
  const list = await desktop.serverList();
  await expect(list.getByRole("status")).toHaveText(
    new RegExp(`A link asked to open ${run.server.replace(/[.]/g, "\\.")}`),
  );
  await expect(list.getByLabel("Address")).toHaveValue(run.server);
});

test("a frame in a server's page stays on the server's pages, and away from the sign-in finish", async ({
  desktop,
  run,
}) => {
  // A page of the stand-in's without the server's policy, which would refuse a frame of another site before the
  // app is asked: here the frames the page makes reach the app's own rule, as on a server with a hole in it.
  const page = await desktop.addServer(run.fake);
  await page.goto(`${run.fake}/__fake/blank`);
  // The app's answer to each frame's navigation, read after its own listener has given it.
  await desktop.app.evaluate(({ BrowserWindow }, origin) => {
    const answers: Record<string, string> = {};
    Object.assign(globalThis, { frameAnswers: answers });
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith(origin))
      ?.webContents.on("will-frame-navigate", (event) => {
        if (!event.isMainFrame) answers[event.url] = event.defaultPrevented ? "stopped" : "let through";
      });
  }, run.fake);
  const handoffLog = async () => (await (await fetch(`${run.fake}/__fake/log`)).json()) as HandoffEvent[];
  const before = (await handoffLog()).length;
  const finish = `${run.fake}/desktop/finish?code=Z&verifier=V`;
  const own = `${run.fake}/e2e/inbox`;
  for (const src of [finish, `${run.direct}/e2e`, "https://example.com/", own]) {
    await page.evaluate(
      (url) => document.body.append(Object.assign(document.createElement("iframe"), { src: url })),
      src,
    );
  }
  await expect
    .poll(() =>
      desktop.app.evaluate(() => (globalThis as unknown as { frameAnswers: Record<string, string> }).frameAnswers),
    )
    .toEqual({
      [finish]: "stopped",
      [`${run.direct}/e2e`]: "stopped",
      "https://example.com/": "stopped",
      [own]: "let through",
    });
  // The finish was never asked for, and nothing was handed to the system browser: a frame opens nothing by itself.
  expect((await handoffLog()).slice(before)).toEqual([]);
  expect((await desktop.recorded()).opened).toEqual([]);
});
