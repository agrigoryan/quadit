import { expect, test } from "./desktop";
import { quadit } from "./run";

test("the bridge is given to the server's own pages and to nothing else", async ({ desktop, run }) => {
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  expect(
    await page.evaluate(() => ({
      version: window.quaditDesktop?.version,
      notify: typeof window.quaditDesktop?.notify,
      setBadge: typeof window.quaditDesktop?.setBadge,
      frozen: Object.isFrozen(window.quaditDesktop),
      node: typeof (window as unknown as { require?: unknown }).require,
    })),
  ).toEqual({ version: "0.1.0", notify: "function", setBadge: "function", frozen: true, node: "undefined" });

  // The app's own server list has its own API, not the bridge.
  const list = await desktop.serverList();
  expect(await list.evaluate(() => typeof window.quaditDesktop)).toBe("undefined");

  // A page of another origin in the server's window (loaded by the app itself, past the navigation rules) gets nothing.
  await desktop.app.evaluate(
    ({ BrowserWindow }, { origin, elsewhere }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(origin));
      void win?.webContents.loadURL(`${elsewhere}/login`);
    },
    { origin: run.server, elsewhere: run.other },
  );
  const away = await desktop.pageOf(run.other);
  await away.waitForLoadState();
  expect(await away.evaluate(() => typeof window.quaditDesktop)).toBe("undefined");
});

test("a notification from the page shows natively, and clicking it brings the window back at its path", async ({
  desktop,
  run,
}) => {
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await page.evaluate(() => Object.assign(window, { stayedLoaded: true }));
  await page.evaluate(() =>
    window.quaditDesktop?.notify({
      title: "Coder assigned you E2E-1",
      body: "Renew the certificate",
      path: "/e2e/settings",
      tag: "n1",
    }),
  );
  await expect
    .poll(async () => (await desktop.recorded()).notes)
    .toEqual([{ title: "Coder assigned you E2E-1", body: "Renew the certificate" }]);

  // Closing a server's window hides it; the click brings it back.
  await desktop.app.evaluate(
    ({ BrowserWindow }, origin) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith(origin))
        ?.close(),
    run.server,
  );
  await expect.poll(() => desktop.isShown(run.server)).toBe(false);
  await desktop.clickLastNotification();
  await expect.poll(() => desktop.isShown(run.server)).toBe(true);
  await expect(page).toHaveURL(`${run.server}/e2e/settings`);
  // Moved by the web app's own router: the page was not reloaded.
  expect(await page.evaluate(() => (window as unknown as { stayedLoaded?: boolean }).stayedLoaded)).toBe(true);
});

test("a notification's path is held to the server: one pointing elsewhere opens the server's root", async ({
  desktop,
  run,
}) => {
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await page.evaluate(() => window.quaditDesktop?.notify({ title: "t", body: "b", path: "//evil.example.com/x" }));
  await expect.poll(async () => (await desktop.recorded()).notes.length).toBe(1);
  await desktop.clickLastNotification();
  await expect(page).toHaveURL(new RegExp(`^${run.server}/`));
  expect(desktop.app.windows().some((p) => p.url().includes("evil.example.com"))).toBe(false);
  expect((await desktop.recorded()).opened).toEqual([]);
});

test("each server's unread count adds up on the dock badge", async ({ desktop, run }) => {
  await desktop.addServer(run.server, "One");
  const one = await desktop.signedIn(run.server);
  await desktop.addServer(run.other, "Two");
  const two = await desktop.signedIn(run.other);

  await one.evaluate(() => window.quaditDesktop?.setBadge(3));
  await two.evaluate(() => window.quaditDesktop?.setBadge(4));
  await expect.poll(() => desktop.badge()).toBe(7);

  // Nonsense is ignored; 0 clears.
  await two.evaluate(() => window.quaditDesktop?.setBadge(Number.NaN));
  await two.evaluate(() => window.quaditDesktop?.setBadge("lots" as unknown as number));
  await expect.poll(() => desktop.badge()).toBe(7);
  await one.evaluate(() => window.quaditDesktop?.setBadge(0));
  await expect.poll(() => desktop.badge()).toBe(4);

  // A removed server's count leaves the sum.
  const list = await desktop.serverList();
  await list.getByRole("button", { name: "Remove Two" }).click();
  await list.getByRole("button", { name: "Yes, remove Two" }).click();
  await expect.poll(() => desktop.badge()).toBe(0);
  await expect(list.getByText("Two", { exact: true })).toBeHidden();
});

test("an inbox item arriving on the live feed is a native notification and a badge", async ({ desktop, run }) => {
  // The web app's half of the bridge comes with the server side of the contract.
  test.skip(!(await fetch(`${run.direct}/api/v1/version`)).ok, "the server's web app does not use the bridge yet");
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);
  const project = `D${Date.now().toString(36).toUpperCase().slice(-5)}`;
  await quadit(run, ["do", "project.create", JSON.stringify({ key: project, name: `Desktop ${project}` })]);
  await quadit(run, [
    "do",
    "agent.create",
    JSON.stringify({ name: "Notifier", handle: `notifier-${project.toLowerCase()}` }),
  ]).catch(() => "");
  const key = (JSON.parse(await quadit(run, ["--json", "new", project, "Renew the certificate"])) as { key: string })
    .key;
  // The owner is told when someone else assigns them: here an agent, through its own token.
  const made = await fetch(`${run.direct}/api/v1/w/e2e/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${run.session.name}=${run.session.value}`,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ name: "notifier", user: `@notifier-${project.toLowerCase()}` }),
  });
  const { token } = (await made.json()) as { token: string };
  await quadit({ ...run, token }, ["assign", key, "@ann-owner"]);

  await expect.poll(async () => (await desktop.recorded()).notes.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => desktop.badge()).toBeGreaterThan(0);
  await desktop.clickLastNotification();
  const page = await desktop.pageOf(run.server);
  await expect(page).toHaveURL(new RegExp(key));
});
