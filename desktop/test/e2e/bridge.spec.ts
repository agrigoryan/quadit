import { APP_VERSION, expect, test } from "./desktop";
import { newTask, OWNER, quadit } from "./run";

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
  ).toEqual({ version: APP_VERSION, notify: "function", setBadge: "function", frozen: true, node: "undefined" });

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
  // Closing a server's window hides it; its page keeps telling.
  await desktop.hide(run.server);
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

  // The click brings the window back.
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
  await desktop.hide(run.server);
  await page.evaluate(() => window.quaditDesktop?.notify({ title: "t", body: "b", path: "//evil.example.com/x" }));
  await expect.poll(async () => (await desktop.recorded()).notes.length).toBe(1);
  await desktop.clickLastNotification();
  await expect(page).toHaveURL(new RegExp(`^${run.server}/`));
  expect(desktop.app.windows().some((p) => p.url().includes("evil.example.com"))).toBe(false);
  expect((await desktop.recorded()).opened).toEqual([]);
});

test("the page cannot send the main process more than it would keep", async ({ desktop, run }) => {
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  // What reaches the main process over IPC, as the main process gets it (a long string by its length).
  await desktop.app.evaluate(({ ipcMain }) => {
    const sent: unknown[] = [];
    Object.assign(globalThis, { sent });
    const short = (value: unknown) => (typeof value === "string" && value.length > 20 ? `${value.length} long` : value);
    for (const channel of ["bridge:notify"]) {
      ipcMain.on(channel, (_event, raw: object) =>
        sent.push(Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, short(value)]))),
      );
    }
  });
  const sent = () => desktop.app.evaluate(() => (globalThis as unknown as { sent: unknown[] }).sent);
  await page.evaluate(() => {
    const huge = "x".repeat(1_000_000);
    const desktop = window.quaditDesktop;
    desktop?.notify({ title: huge, body: huge, path: "/e2e", tag: "t", id: "n" });
    // Too long to be kept: not sent at all.
    desktop?.notify({ title: "t", body: "b", path: "/" + huge });
    desktop?.notify({ title: "t", body: "b", path: "/e2e", tag: huge });
    desktop?.notify({ title: "t", body: "b", path: "/e2e", id: huge });
  });
  await expect.poll(sent).toEqual([{ title: "200 long", body: "1000 long", path: "/e2e", tag: "t", id: "n" }]);
});

test("the Dock badge counts what waits on the person in each server's workspace, never what is unread", async ({
  desktop,
  run,
}) => {
  const { key } = await newTask(run, "Pick a level");
  await desktop.addServer(run.server, "One");
  const one = await desktop.signedIn(run.server);
  // What a page says is unread counts for nothing.
  await one.evaluate(() => window.quaditDesktop?.setBadge(7, "e2e"));
  await expect.poll(() => desktop.badge()).toBe(0);
  // A question asked of the person waits on them.
  await quadit(run, ["ask", key, "Which level?", "option=One", "option=Two", `ask=@${OWNER.handle}`], run.agentToken);
  await expect.poll(() => desktop.badge(), { timeout: 20_000 }).toBe(1);
  // The same workspace through another server's window: that server's number adds up.
  await desktop.addServer(run.other, "Two");
  await desktop.signedIn(run.other);
  await expect.poll(() => desktop.badge(), { timeout: 20_000 }).toBe(2);
  // A removed server's number leaves the sum.
  const list = await desktop.serverList();
  await list.getByRole("button", { name: "Remove Two" }).click();
  await list.getByRole("button", { name: "Yes, remove Two" }).click();
  await expect.poll(() => desktop.badge()).toBe(1);
});

test("an inbox item is shown once whichever windows tell it, and not while its server's window is in front", async ({
  desktop,
  run,
}) => {
  await desktop.addServer(run.server);
  const main = await desktop.signedIn(run.server);
  const opened = desktop.app.waitForEvent("window");
  await main.evaluate(() => window.open("/e2e/inbox", "_blank"));
  const second = await opened;
  await second.waitForLoadState();
  // Out of sight: the second window too.
  await desktop.app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.hide();
  });

  const item = { title: "Bea assigned you E2E-1", body: "", path: "/e2e/inbox", id: "n-once" };
  await main.evaluate((n) => window.quaditDesktop?.notify(n), item);
  await second.evaluate((n) => window.quaditDesktop?.notify(n), item);
  await expect.poll(async () => (await desktop.recorded()).notes.length).toBe(1);

  // In front of the person, the web app shows it: no notification. (macOS gives focus only to the
  // app in front, which an app started by a test is not: the system's answer is stood in for.)
  await desktop.app.evaluate(({ BrowserWindow }, origin) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === `${origin}/e2e/my-work`);
    win?.show();
    BrowserWindow.getFocusedWindow = () => win ?? null;
  }, run.server);
  await main.evaluate((n) => window.quaditDesktop?.notify(n), { ...item, id: "n-in-front" });
  // Then out of sight again, another one is shown: the one in front was dropped, not late.
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.hide());
  await main.evaluate((n) => window.quaditDesktop?.notify(n), { ...item, title: "Out of sight", id: "n-away" });
  await expect
    .poll(async () => (await desktop.recorded()).notes.map((note) => note.title))
    .toEqual(["Bea assigned you E2E-1", "Out of sight"]);
});

test("an inbox item arriving on the live feed is a native notification and a badge", async ({ desktop, run }) => {
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);
  await desktop.hide(run.server);
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
  try {
    await expect.poll(async () => (await desktop.recorded()).notes.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => desktop.badge()).toBeGreaterThan(0);
    await desktop.clickLastNotification();
    const page = await desktop.pageOf(run.server);
    await expect(page).toHaveURL(new RegExp(key));
  } finally {
    // The owner's inbox is shared by every test: read, it adds nothing to another test's badge.
    await quadit(run, ["do", "notification.read", JSON.stringify({ all: true })]);
  }
});
