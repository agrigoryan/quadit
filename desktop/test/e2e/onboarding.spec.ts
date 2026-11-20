// The first run, as a person meets it (desktop contract §7 and §8):
// Welcome, a name, "Set up on this computer", the workspace, signed in,
// and, where an agent tool is found, Welcome's step that connects it with
// one button; or "Connect to a server", as far as it goes without a
// browser. Each step's window is saved as a picture in
// onboarding-screens/ (outside test-results, which Playwright empties at
// every run), in the order a person sees them; desktop-ci keeps the folder
// on every run as the artifact desktop-onboarding-screens.

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Desktop, expect, fakeComputer, slowToStart, test } from "./desktop";

const SCREENS = join(__dirname, "../../onboarding-screens");

/** Saves what `page`'s window shows as `name` in the screens folder. */
async function screen(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: join(SCREENS, name) });
}

/** Whether one of the app's own pages, `file`, is open. */
function isOpen(desktop: Desktop, file: string): boolean {
  return desktop.app.windows().some((page) => page.url().endsWith(`/${file}`));
}

test("the first run sets Quadit up on this computer with a name alone, lands in the workspace signed in, and connects the tool found with one button", async ({
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
    const welcome = await desktop.appPage("welcome.html");
    await expect(welcome.getByRole("heading", { level: 1, name: "Welcome to Quadit" })).toBeVisible();
    const name = welcome.getByLabel("Your name");
    // Offered: the name of the person's account on this computer.
    await expect(name).not.toHaveValue("");
    await expect(welcome.getByRole("button", { name: "Connect to a server" })).toBeVisible();
    expect(isOpen(desktop, "setup.html")).toBe(false);
    await screen(welcome, "01-welcome.png");

    await name.fill("Lou Local");
    await screen(welcome, "02-name.png");
    await welcome.getByRole("button", { name: "Set up on this computer" }).click();
    await expect(welcome.getByText("Starting Quadit…")).toBeVisible();
    await screen(welcome, "03-starting.png");

    origin = await desktop.localOrigin();
    const page = await desktop.pageOf(origin);
    // The workspace the app made, signed in as the name given: no form, no browser.
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(`${origin}/personal/my-work`);
    const me = (await page.evaluate(async () => (await fetch("/api/v1/auth/me")).json())) as { user: { name: string } };
    expect(me.user.name).toBe("Lou Local");
    expect((await desktop.recorded()).opened).toEqual([]);

    // Welcome's last step, over the workspace: the tool found, one button, a way to skip, and how to do it later.
    await expect(welcome.getByRole("heading", { name: "Connect your AI tools" })).toBeVisible();
    await expect(
      welcome.getByText(
        "Quadit found these on your computer. Connected, they can take tasks, ask you questions and report back here.",
      ),
    ).toBeVisible();
    await expect(welcome.getByRole("button", { name: "Skip for now" })).toBeVisible();
    await expect(
      welcome.getByText("You can connect tools later from the Agents page, or from the menu: Connect Agents…"),
    ).toBeVisible();
    await screen(welcome, "04-connect-agents.png");

    // What it changes, before anything is changed.
    const skill = join(computer.home, ".claude", "skills", "quadit", "SKILL.md");
    await welcome.getByRole("button", { name: "See what connecting Claude Code changes" }).click();
    await expect(welcome.getByText(skill)).toBeVisible();
    expect(existsSync(skill)).toBe(false);

    // Connected, with nothing asked: the command and its skill, as an agent of the tool's own name.
    await welcome.getByRole("button", { name: "Connect Claude Code" }).click();
    await expect(welcome.getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(welcome.getByRole("button", { name: "Done" })).toBeVisible();
    await screen(welcome, "04b-connected.png");
    expect(existsSync(skill)).toBe(true);
    const settings = JSON.parse(readFileSync(join(computer.home, ".claude", "settings.json"), "utf8")) as {
      env?: { QUADIT_CONFIG?: string };
    };
    expect(settings.env?.QUADIT_CONFIG).toBe(join(computer.configDir, "claude.json"));
    const ledger = JSON.parse(readFileSync(join(data, "connections.json"), "utf8")) as {
      harnesses: Record<string, { methods: string[]; agent: { handle: string } }>;
    };
    expect(ledger.harnesses.claude).toMatchObject({ methods: ["cli"], agent: { handle: "claude-code" } });

    await welcome.getByRole("button", { name: "Done" }).click();
    await expect.poll(() => isOpen(desktop, "welcome.html")).toBe(false);
    // The Connect window does not open by itself: the step was in Welcome.
    expect(isOpen(desktop, "connect.html")).toBe(false);
    await screen(page, "05-workspace.png");
  } finally {
    await desktop.close();
  }

  // Started again: the workspace again, signed in, and Connect agents does not come back by itself.
  desktop = await Desktop.launch(data, run, [], { env });
  try {
    const page = await desktop.pageOf(origin);
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
    expect(isOpen(desktop, "connect.html")).toBe(false);
    expect(isOpen(desktop, "welcome.html")).toBe(false);
  } finally {
    await desktop.close();
  }
});

test("after a first set-up on a computer where no agent tool is found, the workspace opens with nothing more to do", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const computer = fakeComputer({ claudeCode: false });
  const env = { QUADIT_DESKTOP_QUADIT: run.binary, HOME: computer.home, SHELL: computer.shell };
  const desktop = await Desktop.launch(data, run, [], { env, firstStart: true });
  try {
    const welcome = await desktop.appPage("welcome.html");
    await welcome.getByLabel("Your name").fill("Lou Local");
    await welcome.getByRole("button", { name: "Set up on this computer" }).click();
    const page = await desktop.pageOf(await desktop.localOrigin());
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible({ timeout: 30_000 });
    // Welcome closes once the set-up is done: no step about tools, and no Connect window.
    await expect.poll(() => isOpen(desktop, "welcome.html")).toBe(false);
    expect(isOpen(desktop, "connect.html")).toBe(false);
  } finally {
    await desktop.close();
  }
});

test("the first run connects to a server elsewhere from Welcome, whose window offers the browser sign-in", async ({
  run,
}) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const desktop = await Desktop.launch(data, run, [], { env: { QUADIT_DESKTOP_QUADIT: run.binary }, firstStart: true });
  try {
    const welcome = await desktop.appPage("welcome.html");
    await welcome.getByRole("button", { name: "Connect to a server" }).click();
    await expect(welcome.getByRole("heading", { name: "Connect to a server" })).toBeVisible();
    await expect(welcome.getByRole("button", { name: "Back" })).toBeVisible();
    await welcome.getByLabel("Address").fill(run.server);
    await screen(welcome, "06-connect-to-a-server.png");
    await welcome.getByRole("button", { name: "Add server" }).click();

    const page = await desktop.pageOf(run.server);
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => isOpen(desktop, "welcome.html")).toBe(false);
    // Nothing was set up on this computer.
    expect(await desktop.app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById("set-up-here"))).toBe(
      true,
    );

    // The browser sign-in is offered over the sign-in page; the system browser takes it from there.
    const bar = await desktop.signInBar();
    await bar.getByRole("button", { name: "Sign in with your browser" }).click();
    await expect.poll(async () => (await desktop.recorded()).opened.length).toBe(1);
    const sent = new URL((await desktop.recorded()).opened[0] ?? "");
    expect(sent.origin + sent.pathname).toBe(`${run.server}/desktop/connect`);
  } finally {
    await desktop.close();
  }
});
