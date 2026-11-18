// Connect, end to end: the app on a home folder of the test's own, with a
// login shell whose PATH holds a stand-in quadit, connects Claude Code to
// the workspace (the token made by the workspace's page on the real
// server), and Disconnect takes it all back. Nothing outside the test's
// folders is touched.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desktop, expect, test } from "./desktop";

/** A home folder, a login shell that says its PATH holds `bin`, and a quadit there that does what Connect runs. */
function fakeComputer() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quadit-desktop-connect-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin);
  const configDir = join(home, "Library", "Application Support", "quadit");
  const shell = join(root, "shell");
  writeFileSync(shell, `#!/bin/sh\necho "PATH=${bin}:/usr/bin:/bin"\n`);
  writeFileSync(
    join(bin, "quadit"),
    `#!/bin/sh
default='${join(configDir, "config.json")}'
case "$1" in
  version) echo "quadit 9.9.9 (agent surface 2.0)" ;;
  skill) printf '# Quadit skill\\n' ;;
  login)
    if [ "$2" = "--path" ]; then echo "\${QUADIT_CONFIG:-$default}"; exit 0; fi
    [ "$3" = "-" ] || exit 2
    read -r token
    config="\${QUADIT_CONFIG:-$default}"
    mkdir -p "$(dirname "$config")"
    printf '{"url":"%s","token":"%s"}\\n' "$2" "$token" > "$config"
    chmod 600 "$config" ;;
esac
`,
  );
  chmodSync(shell, 0o755);
  chmodSync(join(bin, "quadit"), 0o755);
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
  return { root, home, configDir, shell };
}

test("Connect sets Claude Code up with its own login and MCP, and Disconnect takes it back", async ({ run }) => {
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

    await connect.getByRole("button", { name: "Connect Claude Code" }).click();
    await expect(connect.getByLabel("Workspace")).toContainText("E2E");
    await connect.getByLabel("Work as").selectOption({ label: "Coder @coder" });
    await connect.getByLabel(/Quadit's MCP server/).check();
    await connect.getByRole("button", { name: "Review changes" }).click();

    // The plan: every file with its diff, the backups, and no token in sight.
    const settings = join(computer.home, ".claude", "settings.json");
    const config = join(computer.configDir, "claude.json");
    const plan = connect.getByRole("region", { name: "Review the changes" });
    await expect(plan).toContainText(settings);
    await expect(plan).toContainText(join(computer.home, ".claude.json"));
    await expect(plan).toContainText(config);
    await expect(plan).toContainText('"token": "qd_…"');
    await expect(plan).toContainText(join(data, "backups"));
    await connect.getByRole("button", { name: "Apply" }).click();
    await expect(connect.getByRole("status")).toContainText("Connected.");

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
    await expect(connect.getByRole("listitem").filter({ hasText: "Claude Code" })).toContainText("as @coder");

    await connect.getByRole("button", { name: "Disconnect Claude Code" }).click();
    await connect.getByRole("button", { name: "Apply" }).click();
    await expect(connect.getByRole("status")).toContainText("Disconnected.");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: ["Read"] } });
    expect(JSON.parse(readFileSync(join(computer.home, ".claude.json"), "utf8"))).toEqual({});
    expect(existsSync(config)).toBe(false);
    expect(existsSync(join(computer.home, ".claude", "skills", "quadit", "SKILL.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(data, "connections.json"), "utf8"))).toEqual({ harnesses: {} });
  } finally {
    await desktop.close();
  }
});
