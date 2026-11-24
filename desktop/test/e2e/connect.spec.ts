// Connect agents, end to end (desktop contract §11): the app's page laid
// over the server's window, never a window of its own, opened from the menu
// and from the Agents page; the app on a home folder of the test's own, with
// a login shell whose PATH holds a stand-in quadit, sets Claude Code up for
// the workspace (the token and the connect code made by the workspace's page
// on the real server), the card waits for the tool, and turns Connected when
// the agent gives the code back with the quadit the app carries; Disconnect
// takes it all back, and scrolls at the window's smallest size. Each state is
// saved as a picture in onboarding-screens/ (desktop.ts, SCREENS). Nothing
// outside the test's folders is touched.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { Desktop, expect, fakeComputer, screen, test } from "./desktop";
import type { Run } from "./run";

/**
 * The quadit the app carries (scripts/cli.mjs builds it, as desktop-ci does
 * before this suite); without it, the run's own, built from the same tree.
 */
function carried(run: Run): string {
  const bundled = join(__dirname, "../../cli", `${process.platform}-${process.arch}`, "quadit");
  return existsSync(bundled) ? bundled : run.binary;
}

/** Runs the quadit the app carries as the login at `config` (the one Connect made for the tool), as the agent in the tool would. */
function asTheTool(run: Run, config: string) {
  const env = { PATH: process.env.PATH ?? "", HOME: run.dir, QUADIT_CONFIG: config };
  return {
    run: (args: string[]) => promisify(execFile)(carried(run), args, { env }),
    start: (args: string[]): ChildProcess => spawn(carried(run), args, { env, stdio: "ignore" }),
  };
}

/** Starts the app on a computer of the test's own, signed in to the run's server, and gives its window's page. */
async function started(run: Run) {
  const computer = fakeComputer();
  const data = join(computer.root, "data");
  mkdirSync(data);
  const desktop = await Desktop.launch(data, run, [], { env: { HOME: computer.home, SHELL: computer.shell } });
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  return { desktop, computer, data, page };
}

const CONNECT = expect.stringMatching(/\/connect\.html$/);

/**
 * Connect agents over the window of the server at `origin`, opened by
 * `open`: its page, laid over that window, and no window of its own made.
 */
async function connectOver(desktop: Desktop, origin: string, open: () => Promise<void>): Promise<Page> {
  const windows = () => desktop.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
  const before = await windows();
  await open();
  const connect = await desktop.appPage("connect.html");
  await expect.poll(() => desktop.overlays(origin)).toContainEqual(CONNECT);
  expect(await windows()).toBe(before);
  return connect;
}

test("Connect agents opens over the server's window from the menu, sets Claude Code up from its card's options, and Disconnect takes it back, scrolling at the smallest size", async ({
  run,
}) => {
  const { desktop, computer, data, page } = await started(run);
  try {
    // With the window closed, the menu opens it first, with Connect over it.
    await desktop.hide(run.server);
    const connect = await connectOver(desktop, run.server, () => desktop.chooseMenuItem("connect"));
    expect(await desktop.isShown(run.server)).toBe(true);
    await expect(connect.getByText(/quadit 9\.9\.9 is on your PATH/)).toBeVisible();
    await expect(connect.getByText(/^For E2E on /)).toBeVisible();
    // The person opened it: no server's name on it, and it takes input at once.
    await expect(connect.getByText(/^Opened by /)).toBeHidden();
    await expect(connect.locator("#connect")).toHaveJSProperty("inert", false);
    // Each side keeps its own: the server's page never gets the app pages' API, nor Connect the bridge.
    expect(await page.evaluate(() => ["quaditDesktop" in window, "quaditPages" in window])).toEqual([true, false]);
    expect(await connect.evaluate(() => ["quaditDesktop" in window, "quaditPages" in window])).toEqual([false, true]);

    // The same card as the first run's; the technical choices wait behind More options.
    const card = connect.getByRole("article", { name: "Claude Code" });
    await expect(card.getByText("Found on this computer")).toBeVisible();
    await screen(connect, "10-connect-found.png");
    await card.getByRole("button", { name: "More options for Claude Code" }).click();
    await card.getByLabel("Work as").selectOption({ label: "Coder @coder" });
    await card.getByLabel(/Quadit's MCP server/).check();
    await card.getByRole("button", { name: "Review changes" }).click();

    // The plan in the sheet: every file in plain words, its exact changes, and no token in sight.
    const settings = join(computer.home, ".claude", "settings.json");
    const config = join(computer.configDir, "claude.json");
    const plan = connect.getByRole("dialog", { name: "What connecting Claude Code changes" });
    await expect(plan.getByText("A login for Claude Code", { exact: true })).toBeVisible();
    await screen(connect, "11-connect-see-the-files.png");
    await plan.getByText("Show the exact changes").click();
    await expect(plan).toContainText(settings);
    await expect(plan).toContainText(join(computer.home, ".claude.json"));
    await expect(plan).toContainText(config);
    await expect(plan).toContainText('"token": "qd_…"');
    await plan.getByRole("button", { name: "Connect Claude Code" }).click();
    await expect(plan).toBeHidden();

    // Set up, waiting for the tool to give its code back: a server other than the app's own, so the app never runs the
    // tool by itself, and the card goes straight to the line to paste (desktop contract §11).
    await expect(card.getByText(/Now open Claude Code and say:$/)).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText(/Quadit could not run/)).toHaveCount(0);
    await expect(card.getByText("Waiting for Claude Code…")).toBeVisible();
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      // Connect also lets it run quadit, and use Quadit's MCP tools, without asking (desktop contract §11).
      permissions: { allow: ["Read", "Bash(quadit:*)", "mcp__quadit"] },
      env: { QUADIT_CONFIG: config },
    });
    const login = JSON.parse(readFileSync(config, "utf8")) as { url: string; token: string };
    expect(login.url).toBe(run.server);
    expect(login.token).not.toBe("");
    expect(JSON.parse(readFileSync(join(computer.home, ".claude.json"), "utf8"))).toEqual({
      mcpServers: { quadit: { type: "http", url: `${run.server}/mcp` } },
    });
    const ledger = readFileSync(join(data, "connections.json"), "utf8");
    expect(JSON.parse(ledger).harnesses.claude.agent.handle).toBe("coder");
    expect(ledger).not.toContain(login.token);
    await card.getByRole("button", { name: "More options for Claude Code" }).click();
    await expect(card.getByText(/as @coder$/)).toBeVisible();

    // Undo, at the window's smallest size: what taking it back does, shown first, scrolls to its end.
    const height = await desktop.resize(run.server, 480, 400);
    await expect.poll(() => connect.evaluate(() => innerHeight)).toBe(height);
    await card.getByRole("button", { name: "Undo Claude Code" }).click();
    const undo = connect.getByRole("dialog", { name: "What disconnecting Claude Code changes" });
    const files = undo.getByText("A login for Claude Code", { exact: true });
    await files.scrollIntoViewIfNeeded();
    await expect(files).toBeInViewport({ ratio: 1 });
    await screen(connect, "15-connect-disconnect-480x400.png");
    await undo.getByText("Show the exact changes").click();
    await expect(undo).toContainText('"token":"qd_…"');
    await expect(undo).not.toContainText(login.token);
    const go = undo.getByRole("button", { name: "Disconnect Claude Code" });
    await expect(go).toBeInViewport({ ratio: 1 });
    await go.click();
    await expect(connect.getByRole("status").filter({ hasText: "Disconnected." })).toBeVisible();
    const again = card.getByRole("button", { name: "Connect Claude Code" });
    await again.scrollIntoViewIfNeeded();
    await expect(again).toBeInViewport({ ratio: 1 });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: ["Read"] } });
    expect(JSON.parse(readFileSync(join(computer.home, ".claude.json"), "utf8"))).toEqual({});
    expect(existsSync(config)).toBe(false);
    expect(existsSync(join(computer.home, ".claude", "skills", "quadit", "SKILL.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(data, "connections.json"), "utf8"))).toEqual({ harnesses: {} });

    // Done goes back to the page that was there.
    await connect.getByRole("button", { name: "Done" }).click();
    await expect.poll(() => desktop.overlays(run.server)).not.toContainEqual(CONNECT);
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
  } finally {
    await desktop.close();
  }
});

// Needs the server's half of §11 (connect codes, quadit connect, quadit wait): it passes once both are merged.
test("a card set up from the Agents page turns Connected when the agent gives its code back with quadit connect, then Listening", async ({
  run,
}) => {
  const { desktop, computer, page } = await started(run);
  let listener: ChildProcess | undefined;
  try {
    await page.goto(`${run.server}/e2e/agents`);
    // The page's header has it; an empty Agents page has it again as its main action.
    const connect = await connectOver(desktop, run.server, () =>
      page.getByRole("button", { name: "Connect an agent on this computer" }).first().click(),
    );
    const card = connect.getByRole("article", { name: "Claude Code" });
    // A server's page asked: it says which, and takes input only after its first moment on screen.
    await expect(connect.getByText(/^Opened by /)).toBeVisible();
    await expect(connect.locator("#connect")).toHaveJSProperty("inert", false);
    await card.getByRole("button", { name: "Connect Claude Code" }).click();

    const line = card.getByText(/^Connect to Quadit \S{6}$/);
    await expect(line).toBeVisible({ timeout: 20_000 });
    await screen(connect, "12-connect-set-up-waiting.png");
    const code = (await line.innerText()).split(" ").at(-1) ?? "";

    // In the tool, the agent gives the code back with its own login, the one Connect made for it.
    const tool = asTheTool(run, join(computer.configDir, "claude.json"));
    await tool.run(["connect", code]);
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
    // Its next step, the line to write in a chat of the tool.
    const step = card.getByRole("group", { name: "Next: have Claude Code listen" });
    await expect(step.locator("code")).toHaveText("listen to Quadit");
    await expect(card.getByRole("button", { name: "Disconnect Claude Code" })).toBeVisible();
    await screen(connect, "13-connect-connected.png");

    // Told to listen, it holds the lease while it waits: the card says so.
    listener = tool.start(["wait", "for=30"]);
    await expect(card.getByText("Listening to everything, from a chat")).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText(/Not listening/)).toBeHidden();
    await expect(step).toHaveCount(0);
    await screen(connect, "14-connect-listening.png");

    // Escape goes back to the Agents page that was there. Its key down takes the page away, so the key is only
    // pressed down: the key up that press would send after it would find the page gone.
    await connect.keyboard.down("Escape");
    await expect.poll(() => desktop.overlays(run.server)).not.toContainEqual(CONNECT);
    await expect(page).toHaveURL(/\/e2e\/agents/);

    // Opened from the menu, it is the person's: nothing says a server asked.
    await desktop.chooseMenuItem("connect");
    const again = await desktop.appPage("connect.html");
    await expect(again.getByText(/^Opened by /)).toBeHidden();
  } finally {
    listener?.kill();
    await desktop.close();
  }
});
