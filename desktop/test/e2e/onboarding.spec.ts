// The first run, as a person meets it (desktop contract §10): one window
// from the first launch to the workspace. Welcome, a name, "Set up on this
// computer", the tools step (looking, the tool found, what connecting it
// changes, Connected and Undo), Continue, and the workspace on its sample
// tasks; or no tool found; or "Connect to a server instead", as far as it
// goes without a browser. Every state is saved as a picture in
// onboarding-screens/ (outside test-results, which Playwright empties at
// every run), in the order a person sees them; desktop-ci keeps the folder
// on every run as the artifact desktop-onboarding-screens.

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Desktop, expect, fakeComputer, slowToStart, test } from "./desktop";

const SCREENS = join(__dirname, "../../onboarding-screens");

/** Saves what `page` shows as `name` in the screens folder. The first run's page fills its window. */
async function screen(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  // Capture the intended state even when a card or the files sheet has just started fading in.
  await page.screenshot({ path: join(SCREENS, name), animations: "disabled" });
}

/** The note the web app shows over the "Getting started" project's task list while its samples are there. */
const SAMPLES_NOTE = "Three sample tasks to try Quadit with.";

test("the first run sets Quadit up on this computer in one window, connects the tool found, and lands on the sample tasks", async ({
  run,
}) => {
  // Two starts of the app, each waiting for its server.
  test.slow();
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  // Claude Code is found on this computer, and the quadit command on its PATH.
  const computer = fakeComputer();
  const env = { QUADIT_DESKTOP_QUADIT: slowToStart(run.binary, 3), HOME: computer.home, SHELL: computer.shell };
  let desktop = await Desktop.launch(data, run, [], { env, firstStart: true });
  let origin = "";
  try {
    const first = await desktop.firstRun();
    await expect(first.getByRole("heading", { level: 1, name: "Welcome to Quadit" })).toBeVisible();
    const name = first.getByLabel("Your name");
    // Offered: the name of the person's account on this computer.
    await expect(name).not.toHaveValue("");
    await expect(first.getByRole("button", { name: "Connect to a server instead" })).toBeVisible();
    // One window, the one the workspace will be in.
    await expect.poll(() => desktop.shownWindows()).toHaveLength(1);
    const [windowId] = await desktop.shownWindows();
    expect(desktop.app.windows().some((page) => page.url().endsWith("/setup.html"))).toBe(false);
    await screen(first, "01-welcome.png");

    await name.fill("Lou Local");
    await screen(first, "02-name.png");
    await first.getByRole("button", { name: "Set up on this computer" }).click();
    await expect(first.getByText("Starting Quadit…")).toBeVisible();
    await screen(first, "03-starting.png");

    // The tools step, in the same page: looking first, for at least about a second.
    await expect(first.getByRole("heading", { level: 1, name: "Connect your AI tools" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(first.getByText("Looking on this computer…")).toBeVisible();
    await screen(first, "04-looking.png");
    const card = first.getByRole("article", { name: "Claude Code" });
    await expect(card.getByText("Found on this computer")).toBeVisible();
    await expect(first.getByText("Quadit found one on this computer.", { exact: false })).toBeVisible();
    await expect(first.getByText("Not on this computer:")).toBeVisible();
    await expect(first.getByRole("button", { name: "Skip for now" })).toBeVisible();
    await expect(first.getByText("You can do this later from the Agents page.")).toBeVisible();
    await screen(first, "05-tools-found.png");

    // Under the page, the workspace the app made, signed in as the name given: no form, no browser.
    origin = await desktop.localOrigin();
    const page = await desktop.pageOf(origin);
    await expect(page).toHaveURL(new RegExp(`^${origin}/personal`), { timeout: 30_000 });
    const me = (await page.evaluate(async () => (await fetch("/api/v1/auth/me")).json())) as { user: { name: string } };
    expect(me.user.name).toBe("Lou Local");
    expect((await desktop.recorded()).opened).toEqual([]);
    // Each side keeps its own: the server's page has the bridge and never the app pages' API; the first run's page
    // has that API and never the bridge.
    expect(await page.evaluate(() => ["quaditDesktop" in window, "quaditPages" in window])).toEqual([true, false]);
    expect(await first.evaluate(() => ["quaditDesktop" in window, "quaditPages" in window])).toEqual([false, true]);

    // What connecting changes, in plain words, before anything is changed.
    const skill = join(computer.home, ".claude", "skills", "quadit", "SKILL.md");
    await card.getByRole("button", { name: "See the files connecting Claude Code changes" }).click();
    const sheet = first.getByRole("dialog", { name: "What connecting Claude Code changes" });
    await expect(sheet.getByText("The Quadit skill", { exact: true })).toBeVisible();
    await expect(sheet.getByText("A login for Claude Code", { exact: true })).toBeVisible();
    await expect(sheet.getByText("~/.claude/skills/quadit/SKILL.md", { exact: true })).toBeVisible();
    // The exact changes wait behind their own control.
    await expect(sheet.getByText(skill, { exact: true })).toBeHidden();
    expect(existsSync(skill)).toBe(false);
    await screen(first, "06-see-the-files.png");
    await sheet.getByText("Show the exact changes").click();
    await expect(sheet.getByText(skill, { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).first().click();
    await expect(sheet).toBeHidden();

    // Connected, with nothing asked: the command and its skill, as an agent of the tool's own name.
    await card.getByRole("button", { name: "Connect Claude Code" }).click();
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText("Try it:")).toBeVisible();
    await expect(first.getByText("Joined just now")).toBeVisible();
    await expect(first.getByText("Connect more later from the Agents page.")).toBeVisible();
    await expect(first.getByRole("button", { name: "Skip for now" })).toBeHidden();
    await screen(first, "07-connected.png");
    expect(existsSync(skill)).toBe(true);
    const settings = JSON.parse(readFileSync(join(computer.home, ".claude", "settings.json"), "utf8")) as {
      env?: { QUADIT_CONFIG?: string };
    };
    expect(settings.env?.QUADIT_CONFIG).toBe(join(computer.configDir, "claude.json"));
    const ledger = () =>
      JSON.parse(readFileSync(join(data, "connections.json"), "utf8")) as {
        harnesses: Record<string, { methods: string[]; agent: { handle: string } }>;
      };
    expect(ledger().harnesses.claude).toMatchObject({ methods: ["cli"], agent: { handle: "claude-code" } });

    // Undo takes it all back, asking nothing; connected again, it is the same agent.
    await card.getByRole("button", { name: "Undo Claude Code" }).click();
    await expect(card.getByRole("button", { name: "Connect Claude Code" })).toBeVisible();
    expect(existsSync(skill)).toBe(false);
    expect(ledger().harnesses).toEqual({});
    await card.getByRole("button", { name: "Connect Claude Code" }).click();
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });

    // Continue (Enter): the sample tasks, the third Claude Code's, and the first run goes, leaving the workspace.
    await first.keyboard.press("Enter");
    await expect.poll(() => desktop.firstRunShown(), { timeout: 20_000 }).toBe(false);
    await expect(page.getByText(SAMPLES_NOTE)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Say hello and tell Lou what you can do")).toBeVisible();
    await expect(page.getByText(/is for Claude Code/)).toBeVisible();
    await screen(page, "08-workspace.png");
    // Never another window: the one it began in.
    expect(await desktop.shownWindows()).toEqual([windowId]);
    // The Connect window does not open by itself.
    expect(desktop.app.windows().some((p) => p.url().includes("/connect.html"))).toBe(false);
  } finally {
    await desktop.close();
  }

  // Started again: the workspace again, signed in, and the first run does not come back by itself.
  desktop = await Desktop.launch(data, run, [], { env });
  try {
    const page = await desktop.pageOf(origin);
    await expect(page).toHaveURL(new RegExp(`^${origin}/personal`), { timeout: 30_000 });
    expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
    expect(desktop.firstRunShown()).toBe(false);
    expect(desktop.app.windows().some((p) => p.url().includes("/connect.html"))).toBe(false);
  } finally {
    await desktop.close();
  }
});

test("Continue waits for both tools when pressed during Connect both", async ({ run }) => {
  const computer = fakeComputer();
  mkdirSync(join(computer.home, ".codex"));
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const env = { QUADIT_DESKTOP_QUADIT: run.binary, HOME: computer.home, SHELL: computer.shell };
  const desktop = await Desktop.launch(data, run, [], { env, firstStart: true });
  const token = Promise.withResolvers<void>();
  try {
    const first = await desktop.firstRun();
    await first.getByRole("button", { name: "Set up on this computer" }).click();
    const both = first.getByRole("button", { name: "Connect both (2)" });
    await expect(both).toBeVisible();
    const page = await desktop.pageOf(await desktop.localOrigin());
    // Hold the first token until Continue has been pressed, then let the real server answer.
    await page.route("**/tokens", async (route) => {
      if (route.request().method() === "POST") await token.promise;
      await route.continue();
    });
    const issuing = page.waitForRequest((req) => req.method() === "POST" && req.url().endsWith("/tokens"));
    await both.click();
    await issuing;
    await first.getByRole("button", { name: "Continue" }).click();
    token.resolve();
    await expect.poll(() => desktop.firstRunShown(), { timeout: 20_000 }).toBe(false);
    await expect(page.getByText(/is for Claude Code/)).toBeVisible();
    const ledger = JSON.parse(readFileSync(join(data, "connections.json"), "utf8"));
    expect(Object.keys(ledger.harnesses).sort()).toEqual(["claude", "codex"]);
  } finally {
    token.resolve();
    await desktop.close();
  }
});

test("set up on a computer where no agent tool is found, the tools step says so calmly, comes back after a quit, and Skip lands on the sample tasks", async ({
  run,
}) => {
  // Two starts of the app, each waiting for its server.
  test.slow();
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const computer = fakeComputer({ claudeCode: false });
  const env = { QUADIT_DESKTOP_QUADIT: run.binary, HOME: computer.home, SHELL: computer.shell };
  let desktop = await Desktop.launch(data, run, [], { env, firstStart: true });
  try {
    const first = await desktop.firstRun();
    await first.getByLabel("Your name").fill("Lou Local");
    await first.getByRole("button", { name: "Set up on this computer" }).click();
    await expect(first.getByText("No AI tools on this computer yet.", { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    await expect(first.getByRole("button", { name: "Look again" })).toBeVisible();
    await expect(first.getByText("Your first agent")).toBeVisible();
    await screen(first, "05b-tools-none-found.png");
    // Looking again finds nothing new, and says so the same way.
    await first.getByRole("button", { name: "Look again" }).click();
    await expect(first.getByRole("button", { name: "Look again" })).toBeVisible();
  } finally {
    // Quit during the tools step: the account is made, and the step is owed.
    await desktop.close();
  }

  desktop = await Desktop.launch(data, run, [], { env });
  try {
    // The next start resumes it, over the workspace's window, for the name given: not Welcome again.
    const first = await desktop.firstRun();
    await expect(first.getByRole("heading", { level: 1, name: "Connect your AI tools" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(first.getByText("No AI tools on this computer yet.", { exact: false })).toBeVisible();
    await expect(first.getByText("Lou Local")).toBeVisible();
    await expect(first.getByRole("heading", { level: 1, name: "Welcome to Quadit" })).toBeHidden();

    await first.getByRole("button", { name: "Skip for now" }).click();
    await expect.poll(() => desktop.firstRunShown(), { timeout: 20_000 }).toBe(false);
    const page = await desktop.pageOf(await desktop.localOrigin());
    // A freshly set-up install has its "Getting started" project: no empty workspace, no banner to make a first one.
    await expect(page.getByText(SAMPLES_NOTE)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Create your first project")).toHaveCount(0);
    expect(desktop.app.windows().some((p) => p.url().includes("/connect.html"))).toBe(false);
  } finally {
    await desktop.close();
  }

  // Skipped, it is over: the next start opens the workspace alone.
  desktop = await Desktop.launch(data, run, [], { env });
  try {
    await desktop.pageOf(await desktop.localOrigin());
    expect(desktop.firstRunShown()).toBe(false);
  } finally {
    await desktop.close();
  }
});

test("the first run connects to a server elsewhere, whose sign-in page its window becomes, offering the browser sign-in", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { env: { QUADIT_DESKTOP_QUADIT: run.binary }, firstStart: true });
  try {
    const first = await desktop.firstRun();
    await expect.poll(() => desktop.shownWindows()).toHaveLength(1);
    const [windowId] = await desktop.shownWindows();
    await first.getByRole("button", { name: "Connect to a server instead" }).click();
    await expect(first.getByRole("heading", { name: "Connect to a server" })).toBeVisible();
    await expect(first.getByRole("button", { name: "Set up on this computer instead" })).toBeVisible();
    // The server built from this tree, which speaks this app's window (inset): the first run's window fits it.
    await first.getByLabel("Address").fill(run.direct);
    await screen(first, "09-connect-to-a-server.png");
    await first.getByRole("button", { name: "Add server" }).click();

    const page = await desktop.pageOf(run.direct);
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => desktop.firstRunShown()).toBe(false);
    expect(await desktop.shownWindows()).toEqual([windowId]);
    // Nothing was set up on this computer.
    expect(await desktop.app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById("set-up-here"))).toBe(
      true,
    );

    // The browser sign-in is offered over the sign-in page; the system browser takes it from there.
    const bar = await desktop.signInBar();
    await bar.getByRole("button", { name: "Sign in with your browser" }).click();
    await expect.poll(async () => (await desktop.recorded()).opened.length).toBe(1);
    const sent = new URL((await desktop.recorded()).opened[0] ?? "");
    expect(sent.origin + sent.pathname).toBe(`${run.direct}/desktop/connect`);
  } finally {
    await desktop.close();
  }
});

test("a server elsewhere that knows nothing of a window without a title bar takes the first run's place in a window of its own, never beside it", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { env: { QUADIT_DESKTOP_QUADIT: run.binary }, firstStart: true });
  try {
    const first = await desktop.firstRun();
    await expect.poll(() => desktop.shownWindows()).toHaveLength(1);
    // A final count alone misses a second window briefly shown beside Welcome.
    const counts = await desktop.app.evaluateHandle(({ app, BaseWindow }) => {
      const shown: number[] = [];
      const record = () => shown.push(BaseWindow.getAllWindows().filter((w) => w.isVisible()).length);
      app.on("browser-window-created", (_event, win) => {
        record();
        win.on("show", record);
      });
      return shown;
    });
    const before = await desktop.app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows().find((w) => w.isVisible());
      if (!win) throw new Error("Welcome has no visible window");
      const { x, y } = win.getBounds();
      win.setBounds({ x: x + 16, y: y + 16, width: 900, height: 640 });
      return win.getBounds();
    });
    await first.getByRole("button", { name: "Connect to a server instead" }).click();
    // The hand-off stand-in answers its version without inset, as a server from before it does.
    await first.getByLabel("Address").fill(run.fake);
    await first.getByRole("button", { name: "Add server" }).click();
    const page = await desktop.pageOf(run.fake);
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => desktop.firstRunShown()).toBe(false);
    // One window on screen, where the first run's was; on macOS it has its title bar.
    const shown = await desktop.app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()
        .filter((w) => w.isVisible())
        .map((w) => ({ bounds: w.getBounds(), content: w.getContentBounds() })),
    );
    expect(shown).toHaveLength(1);
    const during = await counts.jsonValue();
    if (process.platform === "darwin") expect(during).toContain(1);
    expect(Math.max(1, ...during)).toBe(1);
    expect(shown[0]?.bounds).toEqual(before);
    if (process.platform === "darwin") expect(shown[0]?.content.height).toBeLessThan(shown[0]?.bounds.height ?? 0);
  } finally {
    await desktop.close();
  }
});

test("the minimum-size first-run window keeps Welcome and both setup choices reachable", async ({ run }) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { env: { QUADIT_DESKTOP_QUADIT: run.binary }, firstStart: true });
  try {
    const first = await desktop.firstRun();
    const setup = first.getByRole("button", { name: "Set up on this computer", exact: true });
    await expect(setup).toBeVisible();
    const contentHeight = await desktop.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.isVisible());
      if (!win) throw new Error("Welcome has no visible window");
      win.setSize(480, 400);
      return win.getContentBounds().height;
    });
    await expect.poll(() => first.evaluate(() => innerHeight)).toBe(contentHeight);
    const logo = first.locator(".mark");
    await logo.scrollIntoViewIfNeeded();
    await expect(logo).toBeInViewport({ ratio: 1 });
    const strip = await first.locator(".window-strip").boundingBox();
    expect((await logo.boundingBox())?.y).toBeGreaterThanOrEqual(strip?.height ?? 0);
    await setup.scrollIntoViewIfNeeded();
    await expect(setup).toBeInViewport({ ratio: 1 });
    await first.getByRole("button", { name: "Connect to a server instead" }).click();
    await expect(first.getByLabel("Address")).toBeFocused();
    await first.getByRole("button", { name: "Set up on this computer instead" }).click();
    await expect(first.getByLabel("Your name")).toBeFocused();
  } finally {
    await desktop.close();
  }
});
