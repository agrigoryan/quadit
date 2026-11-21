// Connect, end to end: the app on a home folder of the test's own, with a
// login shell whose PATH holds a stand-in quadit, connects Claude Code to
// the workspace (the token made by the workspace's page on the real
// server), and Disconnect takes it all back. Nothing outside the test's
// folders is touched.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Desktop, expect, fakeComputer, test } from "./desktop";

test("Connect sets Claude Code up with its own login and MCP from its card's options, and Disconnect takes it back", async ({
  run,
}) => {
  const computer = fakeComputer();
  const data = join(computer.root, "data");
  mkdirSync(data);
  const desktop = await Desktop.launch(data, run, [], { env: { HOME: computer.home, SHELL: computer.shell } });
  try {
    await desktop.addServer(run.server);
    await desktop.signedIn(run.server);
    await desktop.chooseMenuItem("connect");
    const connect = await desktop.appPage("connect.html");
    await expect(connect.getByText(/quadit 9\.9\.9 is on your PATH/)).toBeVisible();
    await expect(connect.getByLabel("Workspace")).toContainText("E2E");

    // The same card as the first run's; the technical choices wait behind More options.
    const card = connect.getByRole("article", { name: "Claude Code" });
    await expect(card.getByText("Found on this computer")).toBeVisible();
    await card.getByRole("button", { name: "More options for Claude Code" }).click();
    await card.getByLabel("Work as").selectOption({ label: "Coder @coder" });
    await card.getByLabel(/Quadit's MCP server/).check();
    await card.getByRole("button", { name: "Review changes" }).click();

    // The plan in the sheet: every file in plain words, its exact changes, and no token in sight.
    const settings = join(computer.home, ".claude", "settings.json");
    const config = join(computer.configDir, "claude.json");
    const plan = connect.getByRole("dialog", { name: "What connecting Claude Code changes" });
    await expect(plan.getByText("A login for Claude Code", { exact: true })).toBeVisible();
    await plan.getByText("Show the exact changes").click();
    await expect(plan).toContainText(settings);
    await expect(plan).toContainText(join(computer.home, ".claude.json"));
    await expect(plan).toContainText(config);
    await expect(plan).toContainText('"token": "qd_…"');
    await plan.getByRole("button", { name: "Connect Claude Code" }).click();
    await expect(plan).toBeHidden();
    await expect(connect.getByRole("status").filter({ hasText: "Connected." })).toBeVisible();

    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      permissions: { allow: ["Read"] },
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
    await expect(card).toContainText("as @coder");

    await card.getByRole("button", { name: "Disconnect Claude Code" }).click();
    // What taking it back does, shown first: the login going, its token masked as it was when it came.
    const undo = connect.getByRole("dialog", { name: "What disconnecting Claude Code changes" });
    await expect(undo.getByText("A login for Claude Code", { exact: true })).toBeVisible();
    await undo.getByText("Show the exact changes").click();
    await expect(undo).toContainText('"token":"qd_…"');
    await expect(undo).not.toContainText(login.token);
    await undo.getByRole("button", { name: "Disconnect Claude Code" }).click();
    await expect(connect.getByRole("status").filter({ hasText: "Disconnected." })).toBeVisible();
    await expect(card.getByRole("button", { name: "Connect Claude Code" })).toBeVisible();
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: ["Read"] } });
    expect(JSON.parse(readFileSync(join(computer.home, ".claude.json"), "utf8"))).toEqual({});
    expect(existsSync(config)).toBe(false);
    expect(existsSync(join(computer.home, ".claude", "skills", "quadit", "SKILL.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(data, "connections.json"), "utf8"))).toEqual({ harnesses: {} });
  } finally {
    await desktop.close();
  }
});

test("the Agents page's Connect a tool on this computer opens the Connect window on that server's workspace", async ({
  run,
}) => {
  const computer = fakeComputer();
  const data = join(computer.root, "data");
  mkdirSync(data);
  const desktop = await Desktop.launch(data, run, [], { env: { HOME: computer.home, SHELL: computer.shell } });
  try {
    await desktop.addServer(run.server);
    const page = await desktop.signedIn(run.server);
    await page.goto(`${run.server}/e2e/agents`);
    // The page's header has it; an empty Agents page has it again as its main action.
    await page.getByRole("button", { name: "Connect a tool on this computer" }).first().click();
    const connect = await desktop.appPage("connect.html?server=" + desktop.serverId(run.server));
    await expect(connect.getByRole("article", { name: "Claude Code" })).toBeVisible();
    await expect(connect.getByLabel("Workspace")).toHaveValue(new RegExp(desktop.serverId(run.server)));
    expect(desktop.app.windows().filter((p) => p.url().includes("/connect.html"))).toHaveLength(1);
  } finally {
    await desktop.close();
  }
});
