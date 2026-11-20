// Quadit on this computer: the app runs the quadit the run built
// (QUADIT_DESKTOP_QUADIT, standing in for the one the packaged app
// carries) on a data folder in its own, makes its owner itself and signs
// its window in without a form whenever it has no session there, and has
// the server stop when it quits. The first run's own way there is
// onboarding.spec.ts.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Desktop, expect, fakeComputer, slowToStart, test } from "./desktop";

/**
 * The app's environment for running `binary` as its server, on a computer
 * of the test's own where no agent tool is found: Welcome ends with the
 * set-up, whatever the machine running the suite has installed.
 */
function serverEnv(binary: string): Record<string, string> {
  const computer = fakeComputer({ claudeCode: false });
  return { QUADIT_DESKTOP_QUADIT: binary, HOME: computer.home, SHELL: computer.shell };
}

/** Whether a Quadit server answers at `origin`. */
async function answers(origin: string): Promise<boolean> {
  try {
    return (await fetch(`${origin}/readyz`)).ok;
  } catch {
    return false;
  }
}

/**
 * A program in the server's place that answers 200 to everything on the
 * address the app gives it, as the server would, but holds no app key:
 * what answers on the port when another program took it. It notes each
 * request it gets: its method, its path, and whether it carried the app
 * key and a cookie.
 */
function impostor(): { binary: string; requests: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "quadit-desktop-impostor-"));
  const log = join(dir, "requests.log");
  const program = join(dir, "impostor.cjs");
  writeFileSync(
    program,
    `const http = require("node:http");
const fs = require("node:fs");
const listen = process.argv[process.argv.indexOf("--listen") + 1];
const at = listen.lastIndexOf(":");
// Held, like the server's input: its end ends this program.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
http
  .createServer((req, res) => {
    const said = [req.method, req.url.split("?")[0], req.headers["x-quadit-app-key"] ? "key" : "-", req.headers.cookie ? "cookie" : "-"];
    fs.appendFileSync(${JSON.stringify(log)}, said.join(" ") + "\\n");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ proof: "0".repeat(64), setup_needed: true }));
  })
  .listen(Number(listen.slice(at + 1)), listen.slice(0, at));
`,
  );
  const binary = join(dir, "quadit");
  writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${program}' "$@"\n`);
  chmodSync(binary, 0o755);
  return {
    binary,
    requests: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

/** Sets Quadit up on this computer from the server list, through Welcome, and gives the server's address and its window on the workspace. */
async function setUpFromTheList(desktop: Desktop): Promise<{ origin: string; page: Page }> {
  const list = await desktop.serverList();
  await list.getByRole("button", { name: "Set up on this computer…" }).click();
  const welcome = await desktop.appPage("welcome.html");
  await welcome.getByLabel("Your name").fill("Lou Local");
  await welcome.getByRole("button", { name: "Set up on this computer" }).click();
  const origin = await desktop.localOrigin();
  const page = await desktop.pageOf(origin);
  await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
  return { origin, page };
}

test("set up on this computer, the app runs a server whose owner it made, shows it as this computer's, and quitting stops it", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { env: serverEnv(run.binary) });
  let origin = "";
  try {
    let page: Page;
    ({ origin, page } = await setUpFromTheList(desktop));
    expect(await answers(origin)).toBe(true);
    expect(existsSync(join(data, "server", "quadit.sqlite"))).toBe(true);
    await expect(page).toHaveURL(`${origin}/personal/my-work`);
    // Signed in in the window itself: no browser was asked.
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
    expect((await desktop.recorded()).opened).toEqual([]);

    // The list shows it as this computer's, running, with its controls; so does the menu.
    await desktop.chooseMenuItem("servers");
    const list = await desktop.serverList();
    await expect(list.getByText("This computer", { exact: true })).toBeVisible();
    await expect(list.getByText("Running on this computer while the app is open")).toBeVisible();
    await expect(list.getByRole("button", { name: "Stop the server on this computer" })).toBeEnabled();
    await expect(list.getByRole("button", { name: "Set up on this computer…" })).toHaveCount(0);
    expect(
      await desktop.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("local-stop")?.enabled),
    ).toBe(true);
    expect(await desktop.app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById("set-up-here"))).toBe(
      false,
    );
  } finally {
    await desktop.close();
  }
  // Quitting the app told its server to stop, which it does on its own, a moment later.
  expect(origin).not.toBe("");
  await expect.poll(() => answers(origin), { timeout: 15_000 }).toBe(false);
});

test("the window of the server on this computer is signed in by the app whenever it has no session: before it loads, and on the sign-in page", async ({
  run,
}) => {
  // Three starts of the app, two of them waiting for its server.
  test.slow();
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const env = serverEnv(run.binary);
  let desktop = await Desktop.launch(data, run, [], { env });
  let origin = "";
  try {
    let page: Page;
    ({ origin, page } = await setUpFromTheList(desktop));
    // Signed out: the web app shows its sign-in page, with the page the person was on as where to go next, and
    // the app signs in again and goes on to that page. The person signs out with the web app's own control, so
    // that the window is moved by the web app and the app alone: a navigation the test started beside theirs
    // would be dropped by the browser whenever the app's own load was already on its way.
    const visited: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });
    await page
      .getByRole("link", { name: /^Inbox/ })
      .first()
      .click();
    await expect(page).toHaveURL(`${origin}/personal/inbox`);
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    try {
      await expect
        .poll(() => visited.some((url) => new URL(url).pathname === "/login"), { timeout: 20_000 })
        .toBe(true);
      await expect(page).toHaveURL(`${origin}/personal/inbox`, { timeout: 20_000 });
    } catch (err) {
      // What the window went through, for whoever reads the failure.
      throw new Error(`${(err as Error).message}\nThe window's navigations since signing out:\n${visited.join("\n")}`, {
        cause: err,
      });
    }
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
  } finally {
    await desktop.close();
  }

  // Started without its server (none to run), the app loads nothing there: its window's cookies are let go here.
  const id = desktop.serverId(origin);
  desktop = await Desktop.launch(data, run);
  try {
    await desktop.app.evaluate(async ({ session }, partition) => {
      const own = session.fromPartition(partition);
      await own.clearStorageData({ storages: ["cookies"] });
      await own.cookies.flushStore();
    }, `persist:server-${id}`);
  } finally {
    await desktop.close();
  }

  // With its server again, the window has no session: the app signs it in before the workspace loads.
  desktop = await Desktop.launch(data, run, [], { env });
  try {
    const page = await desktop.pageOf(origin);
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
    expect((await desktop.recorded()).opened).toEqual([]);
  } finally {
    await desktop.close();
  }
});

test("without a server to run, Welcome offers only connecting to one, and setup says why in a sentence", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { firstStart: true });
  try {
    const welcome = await desktop.appPage("welcome.html");
    await expect(welcome.getByRole("heading", { name: "Connect to a server" })).toBeVisible();
    await expect(welcome.getByLabel("Address")).toBeVisible();
    await expect(welcome.getByRole("button", { name: "Set up on this computer" })).toHaveCount(0);
    await expect(welcome.getByLabel("Your name")).toBeHidden();
    await expect(welcome.getByRole("button", { name: "Back" })).toBeHidden();

    await desktop.chooseMenuItem("setup");
    const setup = await desktop.appPage("setup.html");
    await expect(setup.getByText("Not available in this copy of the app")).toBeVisible();
    await expect(setup.getByRole("button", { name: "Set up on this computer…" })).toHaveCount(0);
  } finally {
    await desktop.close();
  }
});

test("a program that answers on the server's port without the app key is never taken for the server: no set-up, no sign-in, no window", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const fake = impostor();
  const desktop = await Desktop.launch(data, run, [], { env: serverEnv(fake.binary) });
  try {
    const list = await desktop.serverList();
    await list.getByRole("button", { name: "Set up on this computer…" }).click();
    const welcome = await desktop.appPage("welcome.html");
    await welcome.getByLabel("Your name").fill("Lou Local");
    await welcome.getByRole("button", { name: "Set up on this computer" }).click();
    await expect(welcome.getByText(/^Another program answers on port \d+ of this computer/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(welcome.getByRole("button", { name: "Try again" })).toBeVisible();
    const origin = await desktop.localOrigin();
    // Asked whether it is up, and for the proof it could not give: nothing else, never the key, never a cookie.
    expect(fake.requests()).toEqual(["GET /healthz - -", "POST /api/v1/auth/app-proof - -"]);
    expect(desktop.app.windows().some((page) => page.url().startsWith(origin))).toBe(false);
    await desktop.chooseMenuItem("servers");
    await expect(list.getByText(/^Another program answers on port \d+ of this computer/)).toBeVisible();
  } finally {
    await desktop.close();
  }
});

test("quit before its set-up was finished, the server on this computer offers Welcome again at the next start, which finishes it", async ({
  run,
}) => {
  // Two starts of the app, the second waiting for its server.
  test.slow();
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  let desktop = await Desktop.launch(data, run, [], {
    env: serverEnv(slowToStart(run.binary, 60)),
    firstStart: true,
  });
  let origin = "";
  try {
    const welcome = await desktop.appPage("welcome.html");
    await welcome.getByLabel("Your name").fill("Lou Local");
    await welcome.getByRole("button", { name: "Set up on this computer" }).click();
    await expect(welcome.getByText("Starting Quadit…")).toBeVisible();
    origin = await desktop.localOrigin();
    // Saved in the list already: the next start has a server, and no first run.
    await expect.poll(() => desktop.serverId(origin)).not.toBe("");
  } finally {
    await desktop.close();
  }

  desktop = await Desktop.launch(data, run, [], { env: serverEnv(run.binary) });
  try {
    const welcome = await desktop.appPage("welcome.html");
    await welcome.getByLabel("Your name").fill("Lou Later");
    await welcome.getByRole("button", { name: "Set up on this computer" }).click();
    const page = await desktop.pageOf(origin);
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(`${origin}/personal/my-work`);
    const me = (await page.evaluate(async () => (await fetch("/api/v1/auth/me")).json())) as { user: { name: string } };
    expect(me.user.name).toBe("Lou Later");
    await expect.poll(() => desktop.app.windows().some((p) => p.url().endsWith("/welcome.html"))).toBe(false);
  } finally {
    await desktop.close();
  }
});
