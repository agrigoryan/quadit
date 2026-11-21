// Connect against a home folder of its own and a stand-in quadit command:
// every file written is under a temporary folder.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Connections } from "@/main/connections";
import { QuaditCli } from "@/main/quadit-cli";
import type { DesktopRequest } from "@/shared/bridge";
import type { ConnectChoice } from "@/shared/pages-api";

/** Connect runs only on macOS and Linux (no Windows build of quadit); these tests need a POSIX shell, links and file modes. */
const posixOnly = describe.skipIf(process.platform === "win32");

const ORIGIN = "https://q.example";

/**
 * A quadit that answers what Connect runs: version, skill, login --path,
 * login URL - with the token on stdin, and --json me, which says the login
 * with token T is the agent @as-T.
 */
function standIn(path: string, defaultConfig: string) {
  writeFileSync(
    path,
    `#!/bin/sh
default='${defaultConfig}'
case "$1" in
  version) echo "quadit 9.9.9 (agent surface 2.0)" ;;
  --json)
    config="\${QUADIT_CONFIG:-$default}"
    [ "$2" = me ] && [ -z "$QUADIT_TOKEN" ] && [ -f "$config" ] || exit 1
    token=$(sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' "$config")
    [ -n "$token" ] || { echo "not signed in" >&2; exit 1; }
    printf '{"user_id":"id-%s","handle":"@as-%s","name":"As %s"}\\n' "$token" "$token" "$token" ;;
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
  chmodSync(path, 0o755);
}

function setUp({
  quaditOnPath = true,
  bundled = true,
  platform = "darwin",
  writableOnPath = true,
  ownBinOnPath = false,
  shell = "/bin/zsh",
}: {
  quaditOnPath?: boolean;
  bundled?: boolean;
  platform?: NodeJS.Platform;
  /** Whether the login PATH has a folder the person may write to (bin); without, only a folder that is not there. */
  writableOnPath?: boolean;
  /** Whether ~/.local/bin is on the login PATH, as Linux distributions put it, there or not. */
  ownBinOnPath?: boolean;
  shell?: string;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quadit-desktop-connect-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const configDir = join(home, "Library", "Application Support", "quadit");
  const script = join(root, "quadit-bundled");
  standIn(script, join(configDir, "config.json"));
  if (quaditOnPath) copyFileSync(script, join(bin, "quadit"));
  const asked: DesktopRequest[] = [];
  let tokens = 0;
  const connections = new Connections({
    home,
    dataDir: join(root, "data"),
    platform,
    hostName: "mac",
    cli: new QuaditCli(
      quaditOnPath || !bundled ? null : script,
      async () =>
        [
          "relative-folder",
          writableOnPath ? bin : join(root, "not-a-folder"),
          ...(ownBinOnPath ? [join(home, ".local", "bin")] : []),
        ].join(":"),
      { home, shell },
    ),
    summaries: () => [
      {
        serverId: "s1",
        listening: true,
        summary: {
          workspace: { id: "w1", slug: "acme", name: "Acme" },
          me: { name: "Ann", canCreateAgents: true },
          waiting: [],
          agents: [
            { id: "u2", handle: "coder", name: "Coder", state: "idle", detail: "", path: "/acme", usable: true },
            { id: "u3", handle: "boss", name: "Boss", state: "idle", detail: "", path: "/acme", usable: false },
          ],
          projects: [],
        },
      },
    ],
    server: (id) => (id === "s1" ? { name: "Work", origin: ORIGIN } : undefined),
    ask: async (_server, _workspace, request) => {
      asked.push(request);
      if (request.kind === "agent-token")
        return { ok: true, token: { id: `t${++tokens}`, secret: `qd_secret${tokens}` } };
      if (request.kind === "agent") {
        return { ok: true, agent: { id: "u9", handle: request.create.handle, name: request.create.name } };
      }
      return { ok: true };
    },
  });
  const choice = (harness: string, extra: Partial<ConnectChoice> = {}): ConnectChoice => ({
    harness,
    serverId: "s1",
    workspaceId: "w1",
    methods: ["cli"],
    agent: { id: "u2" },
    allowUnattended: false,
    ...extra,
  });
  const connect = async (c: ConnectChoice) => {
    const planned = await connections.planConnect(c);
    if (!planned.ok) throw new Error(planned.error);
    const applied = await connections.applyConnect(planned.plan.id);
    if (!applied.ok) throw new Error(applied.error);
    return applied.hint;
  };
  const disconnect = async (harness: string) => {
    const planned = connections.planDisconnect(harness);
    if (!planned.ok) throw new Error(planned.error);
    const applied = await connections.applyDisconnect(planned.plan.id);
    if (!applied.ok) throw new Error(applied.error);
    return applied.notes;
  };
  const read = (path: string) => readFileSync(join(home, path), "utf8");
  const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
  const ledger = () => readFileSync(join(root, "data", "connections.json"), "utf8");
  return { root, home, bin, configDir, connections, asked, choice, connect, disconnect, read, json, ledger };
}

posixOnly("Connect plans", () => {
  const cases: [string, ConnectChoice["methods"], string[]][] = [
    [
      "claude",
      ["cli", "mcp"],
      [
        ".claude/skills/quadit/SKILL.md",
        "Library/Application Support/quadit/claude.json",
        ".claude/settings.json",
        ".claude.json",
      ],
    ],
    [
      "codex",
      ["cli", "mcp"],
      [".agents/skills/quadit/SKILL.md", "Library/Application Support/quadit/codex.json", ".codex/config.toml"],
    ],
    [
      "gemini",
      ["cli", "mcp"],
      [".agents/skills/quadit/SKILL.md", "Library/Application Support/quadit/config.json", ".gemini/settings.json"],
    ],
    [
      "antigravity",
      ["cli", "mcp"],
      [
        ".gemini/config/skills/quadit/SKILL.md",
        "Library/Application Support/quadit/config.json",
        ".gemini/config/mcp_config.json",
      ],
    ],
    [
      "cursor",
      ["cli", "mcp"],
      [".agents/skills/quadit/SKILL.md", "Library/Application Support/quadit/config.json", ".cursor/mcp.json"],
    ],
    [
      "opencode",
      ["cli", "mcp"],
      [
        ".agents/skills/quadit/SKILL.md",
        "Library/Application Support/quadit/config.json",
        ".config/opencode/opencode.json",
      ],
    ],
    ["pi", ["cli"], [".agents/skills/quadit/SKILL.md", "Library/Application Support/quadit/config.json"]],
    ["copilot", ["cli"], [".agents/skills/quadit/SKILL.md", "Library/Application Support/quadit/config.json"]],
  ];
  for (const [harness, methods, files] of cases) {
    it(`plans ${harness} from an empty home: every file it writes`, async () => {
      const { connections, choice, home } = setUp();
      const planned = await connections.planConnect(choice(harness, { methods }));
      if (!planned.ok) throw new Error(planned.error);
      expect(planned.plan.files.map((f) => f.path)).toEqual(files.map((f) => join(home, f)));
      // The token is never in a plan, only masked.
      expect(JSON.stringify(planned.plan)).not.toContain("qd_secret");
      expect(planned.plan.files.find((f) => f.path.includes("Application Support"))?.diff).toContain('"token": "qd_…"');
    });
  }

  it("says what each file is to the plan, for its plain words, and where it is as a person writes it", async () => {
    const { connections, choice, home } = setUp({ quaditOnPath: false, writableOnPath: false });
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    const claude = await connections.planConnect(choice("claude"));
    if (!claude.ok) throw new Error(claude.error);
    expect(claude.plan.files.map((f) => [f.shown, f.role, f.change])).toEqual([
      ["~/.local/bin", "folder", "new"],
      ["~/.local/bin/quadit", "command", "new"],
      ["~/.zprofile", "profile", "new"],
      ["~/.claude/skills/quadit/SKILL.md", "skill", "new"],
      ["~/Library/Application Support/quadit/claude.json", "login", "new"],
      ["~/.claude/settings.json", "settings", "edited"],
    ]);
    // Without a setting for a login of its own, the login the plan makes is the computer's.
    const pi = await connections.planConnect(choice("pi"));
    if (!pi.ok) throw new Error(pi.error);
    expect(pi.plan.files.find((f) => f.path.endsWith("config.json"))?.role).toBe("shared-login");
  });

  it("says a disconnect takes the files it made away and puts the others back, the login among them", async () => {
    const { connections, connect, choice, home } = setUp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    await connect(choice("claude"));
    const planned = connections.planDisconnect("claude");
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.plan.files.map((f) => [f.shown, f.role, f.change])).toEqual([
      ["~/.claude/skills/quadit/SKILL.md", "skill", "removed"],
      ["~/Library/Application Support/quadit/claude.json", "login", "removed"],
      ["~/.claude/settings.json", "settings", "restored"],
    ]);
  });

  it("says which harnesses work as the default login, and offers MCP where it has it", async () => {
    const { connections } = setUp();
    const view = await connections.state();
    expect(view.harnesses.map((h) => [h.id, h.cliIdentity, h.mcp])).toEqual([
      ["claude", "own", true],
      ["codex", "own", true],
      ["gemini", "default", true],
      ["antigravity", "default", true],
      ["cursor", "default", true],
      ["opencode", "default", true],
      ["pi", "default", false],
      ["copilot", "default", false],
    ]);
    expect(view.cli.found).toMatch(/bin\/quadit$/);
    expect(view.cli.version).toBe("9.9.9");
  });

  it("plans from existing files, keeping what is in them", async () => {
    const { connections, choice, home } = setUp();
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), '{\n  // mine\n  "model": "x"\n}\n');
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
    const opencode = await connections.planConnect(choice("opencode", { methods: ["mcp"] }));
    if (!opencode.ok) throw new Error(opencode.error);
    const diff = opencode.plan.files.find((f) => f.path.endsWith("opencode.jsonc"))?.diff ?? "";
    expect(diff).toContain("// mine");
    expect(diff).toContain('+    "quadit": {');
    const claude = await connections.planConnect(choice("claude", { allowUnattended: true }));
    if (!claude.ok) throw new Error(claude.error);
    const settings = claude.plan.files.find((f) => f.path.endsWith(".claude/settings.json"))?.diff ?? "";
    expect(settings).toContain('"Read"');
    expect(settings).toContain('+      "Bash(quadit:*)"');
  });

  it("refuses a conflicting file with what to do by hand", async () => {
    const { connections, choice, home } = setUp();
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.quadit]\nurl = "https://old/mcp"\n');
    const planned = await connections.planConnect(choice("codex", { methods: ["mcp"] }));
    expect(planned).toEqual({
      ok: false,
      error: expect.stringContaining(`${join(home, ".codex", "config.toml")} already has mcp_servers.quadit`),
    });
    mkdirSync(join(home, ".gemini"));
    writeFileSync(join(home, ".gemini", "settings.json"), "{ not json");
    expect(await connections.planConnect(choice("gemini", { methods: ["mcp"] }))).toMatchObject({ ok: false });
  });

  it("refuses an agent the person may not connect as, and a workspace no window shows", async () => {
    const { connections, choice } = setUp();
    expect(await connections.planConnect(choice("claude", { agent: { id: "u3" } }))).toMatchObject({ ok: false });
    expect(await connections.planConnect(choice("claude", { workspaceId: "w2" }))).toMatchObject({ ok: false });
  });
});

posixOnly("Connect and Disconnect", () => {
  it("connects Claude Code with its own login and MCP, and takes it all back", async () => {
    const { connect, disconnect, asked, read, json, home, configDir, ledger } = setUp();
    mkdirSync(join(home, ".claude"));
    const settings = JSON.stringify({ permissions: { allow: ["Read"] } });
    writeFileSync(join(home, ".claude", "settings.json"), settings);
    const hint = await connect({
      harness: "claude",
      serverId: "s1",
      workspaceId: "w1",
      methods: ["cli", "mcp"],
      agent: { id: "u2" },
      allowUnattended: true,
    });
    expect(hint).toContain("@coder");
    expect(asked).toEqual([{ kind: "agent-token", agent: "u2", label: "Claude Code on mac" }]);
    const config = join(configDir, "claude.json");
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ url: ORIGIN, token: "qd_secret1" });
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(json(".claude/settings.json")).toEqual({
      permissions: { allow: ["Read", "Bash(quadit:*)", "mcp__quadit"] },
      env: { QUADIT_CONFIG: config },
    });
    expect(json(".claude.json")).toEqual({ mcpServers: { quadit: { type: "http", url: `${ORIGIN}/mcp` } } });
    expect(read(".claude/skills/quadit/SKILL.md")).toBe("# Quadit skill\n");
    // The ledger keeps the token's id, never the token.
    expect(ledger()).toContain('"id": "t1"');
    expect(ledger()).not.toContain("qd_secret");

    expect(await disconnect("claude")).toEqual([]);
    expect(json(".claude/settings.json")).toEqual(JSON.parse(settings));
    expect(json(".claude.json")).toEqual({});
    expect(existsSync(config)).toBe(false);
    expect(existsSync(join(home, ".claude/skills/quadit/SKILL.md"))).toBe(false);
    expect(asked.at(-1)).toEqual({ kind: "revoke-token", token: "t1" });
    expect(JSON.parse(ledger())).toEqual({ harnesses: {} });
  });

  it("leaves a file changed since alone, and says so", async () => {
    const { connect, disconnect, json, home, choice } = setUp();
    await connect(choice("cursor", { methods: ["mcp"] }));
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { quadit: { url: "https://mine" } } }),
    );
    expect(await disconnect("cursor")).toEqual([
      `${join(home, ".cursor", "mcp.json")}: mcpServers.quadit changed since the app set it; left as it is.`,
    ]);
    expect(json(".cursor/mcp.json")).toEqual({ mcpServers: { quadit: { url: "https://mine" } } });
  });

  it("shares the skill and the default login between harnesses, and takes them back with the last", async () => {
    const { connect, disconnect, asked, home, configDir, choice } = setUp();
    await connect(choice("gemini"));
    await connect(choice("cursor", { agent: null }));
    // One token for the default login, made once.
    expect(asked.filter((r) => r.kind === "agent-token")).toHaveLength(1);
    const skill = join(home, ".agents", "skills", "quadit", "SKILL.md");
    const config = join(configDir, "config.json");
    await disconnect("gemini");
    expect(existsSync(skill)).toBe(true);
    expect(existsSync(config)).toBe(true);
    expect(asked.some((r) => r.kind === "revoke-token")).toBe(false);
    await disconnect("cursor");
    expect(existsSync(skill)).toBe(false);
    expect(existsSync(config)).toBe(false);
    expect(asked.at(-1)).toEqual({ kind: "revoke-token", token: "t1" });
  });

  it("leaves a default login it did not make as it is", async () => {
    const { connections, connect, disconnect, asked, configDir, choice } = setUp();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ url: "https://mine.example", token: "qd_mine" }));
    expect((await connections.state()).defaultLogin).toEqual({ server: "https://mine.example", agent: "@as-qd_mine" });
    await connect(choice("pi", { agent: null }));
    expect(asked).toEqual([]);
    await disconnect("pi");
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))).toEqual({
      url: "https://mine.example",
      token: "qd_mine",
    });
  });

  it("links the app's own quadit into the PATH when there is none, until the last harness goes", async () => {
    const { connect, disconnect, bin, root, choice } = setUp({ quaditOnPath: false });
    await connect(choice("codex"));
    await connect(choice("pi"));
    const link = join(bin, "quadit");
    expect(readlinkSync(link)).toBe(join(root, "quadit-bundled"));
    await disconnect("codex");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    await disconnect("pi");
    expect(existsSync(link)).toBe(false);
  });

  it("makes a new agent first when asked to", async () => {
    const { connect, asked, choice } = setUp();
    await connect(choice("codex", { agent: { create: { name: "Codex", handle: "codex" } } }));
    expect(asked).toEqual([
      { kind: "agent", create: { name: "Codex", handle: "codex" } },
      { kind: "agent-token", agent: "u9", label: "Codex on mac" },
    ]);
  });

  it("asks for another look when a file changed after the plan, and a plan is good for one Apply", async () => {
    const { connections, choice, home } = setUp();
    const planned = await connections.planConnect(choice("cursor", { methods: ["mcp"] }));
    if (!planned.ok) throw new Error(planned.error);
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{}");
    expect(await connections.applyConnect(planned.plan.id)).toEqual({
      ok: false,
      error: `${join(home, ".cursor", "mcp.json")} changed since you reviewed the plan: review it again.`,
    });
    expect(await connections.applyConnect(planned.plan.id)).toMatchObject({ ok: false });
  });
});

posixOnly("an older quadit", () => {
  it("is refused with a word to update it", async () => {
    const { connections, choice, bin } = setUp();
    writeFileSync(
      join(bin, "quadit"),
      '#!/bin/sh\n[ "$1" = login ] && { echo "usage: quadit login URL TOKEN" >&2; exit 2; }\necho ok\n',
    );
    expect(await connections.planConnect(choice("claude"))).toEqual({
      ok: false,
      error: expect.stringMatching(/is older than this app and cannot be connected: update it/),
    });
  });
});

posixOnly("the default login", () => {
  it("says whom a harness without a login of its own will work as, and records that agent, not another", async () => {
    const { connections, connect, choice, ledger } = setUp();
    await connect(choice("gemini"));
    // Cursor would share Gemini's login, made for @coder (token qd_secret1): no other agent holds.
    const planned = await connections.planConnect(choice("cursor", { agent: null }));
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.plan.warnings.join(" ")).toContain(
      "works as this computer's default login: @as-qd_secret1 on https://q.example",
    );
    const hint = await connect(choice("cursor", { agent: null }));
    expect(hint).toContain("default login, @as-qd_secret1");
    expect(JSON.parse(ledger()).harnesses.cursor.agent).toEqual({ id: "id-qd_secret1", handle: "as-qd_secret1" });
  });

  it("still asks for an agent where the choice holds: with no default login yet, or for MCP", async () => {
    const { connections, connect, choice } = setUp();
    expect(await connections.planConnect(choice("gemini", { agent: null }))).toEqual({
      ok: false,
      error: "Pick an agent you may connect as.",
    });
    await connect(choice("pi"));
    expect(await connections.planConnect(choice("gemini", { methods: ["cli", "mcp"], agent: null }))).toMatchObject({
      ok: false,
    });
  });

  it("refuses when the default login cannot say who it is", async () => {
    const { connections, configDir, choice } = setUp();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "{}");
    expect(await connections.planConnect(choice("pi", { agent: null }))).toEqual({
      ok: false,
      error: expect.stringContaining("did not say who it is"),
    });
  });
});

posixOnly("plans", () => {
  it("keeps one outstanding: a new one, or dropping, takes the last away", async () => {
    const { connections, choice } = setUp();
    const first = await connections.planConnect(choice("cursor", { methods: ["mcp"] }));
    const second = await connections.planConnect(choice("cursor", { methods: ["mcp"] }));
    if (!first.ok || !second.ok) throw new Error("not planned");
    expect(await connections.applyConnect(first.plan.id)).toMatchObject({ ok: false });
    connections.dropPlans();
    expect(await connections.applyConnect(second.plan.id)).toMatchObject({ ok: false });
  });

  it("offers the install script, not a link, where the app has no copy it can link (an AppImage)", async () => {
    const { connections, choice, bin } = setUp({ quaditOnPath: false, bundled: false });
    expect((await connections.state()).cli.manual).toContain("install.sh | sh");
    expect(await connections.planConnect(choice("pi"))).toEqual({
      ok: false,
      error: expect.stringContaining("install.sh | sh"),
    });
    expect(existsSync(join(bin, "quadit"))).toBe(false);
  });
});

describe("on Windows", () => {
  it("says Connect is not available, and plans nothing", async () => {
    const { connections, choice, home } = setUp({ platform: "win32" });
    expect(await connections.state()).toMatchObject({ supported: false, defaultLogin: null });
    expect(await connections.planConnect(choice("claude"))).toEqual({
      ok: false,
      error:
        "Connecting agent tools is not available on Windows yet: it needs the quadit command, which has no Windows build.",
    });
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});

posixOnly("The app's quadit without a folder on the PATH it may write to", () => {
  const LINE = 'export PATH="$HOME/.local/bin:$PATH" # Added by the Quadit app: Disconnect in the app takes it out.';

  it("goes in ~/.local/bin, put on the PATH by one line in the login shell's profile, shown first and taken back with the last harness", async () => {
    const { connections, connect, disconnect, home, root, choice } = setUp({
      quaditOnPath: false,
      writableOnPath: false,
    });
    const own = join(home, ".local", "bin");
    const profile = join(home, ".zprofile");
    expect((await connections.state()).cli).toMatchObject({
      found: null,
      linkInto: "~/.local/bin",
      profile: "~/.zprofile",
      manual: null,
    });
    const planned = await connections.planConnect(choice("codex"));
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.plan.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([own, join(own, "quadit"), profile]),
    );
    connections.dropPlans();

    const hint = await connect(choice("codex"));
    expect(hint).toContain("Terminals opened from now on find quadit; reopen any that are open now.");
    expect(readlinkSync(join(own, "quadit"))).toBe(join(root, "quadit-bundled"));
    expect(readFileSync(profile, "utf8")).toBe(`${LINE}\n`);
    // The login PATH this session sees has no ~/.local/bin yet: the app uses its link anyway, and adds no line twice.
    expect((await connections.state()).cli.found).toBe(join(own, "quadit"));
    await connect(choice("pi"));
    expect(readFileSync(profile, "utf8")).toBe(`${LINE}\n`);

    await disconnect("codex");
    expect(readFileSync(profile, "utf8")).toBe(`${LINE}\n`);
    expect(lstatSync(join(own, "quadit")).isSymbolicLink()).toBe(true);
    await disconnect("pi");
    // The profile the app made goes with its line; the link and the folder it made go too.
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(own)).toBe(false);
  });

  it("keeps the rest of a profile there already, and takes out only its line", async () => {
    const { connect, disconnect, home, choice } = setUp({
      quaditOnPath: false,
      writableOnPath: false,
      shell: "/bin/bash",
    });
    writeFileSync(join(home, ".bash_profile"), "source ~/.bashrc\n");
    await connect(choice("codex"));
    expect(readFileSync(join(home, ".bash_profile"), "utf8")).toBe(`source ~/.bashrc\n${LINE}\n`);
    expect(existsSync(join(home, ".profile"))).toBe(false);
    await disconnect("codex");
    expect(readFileSync(join(home, ".bash_profile"), "utf8")).toBe("source ~/.bashrc\n");
  });

  it("only makes ~/.local/bin and links there where it is on the PATH already but not there (Linux)", async () => {
    const { connections, connect, home, choice } = setUp({
      quaditOnPath: false,
      writableOnPath: false,
      ownBinOnPath: true,
      shell: "/bin/bash",
    });
    expect((await connections.state()).cli).toMatchObject({ linkInto: "~/.local/bin", profile: null });
    const planned = await connections.planConnect(choice("codex"));
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.plan.files.some((file) => /profile/.test(file.path))).toBe(false);
    connections.dropPlans();
    await connect(choice("codex"));
    expect(lstatSync(join(home, ".local", "bin", "quadit")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, ".profile"))).toBe(false);
    expect(existsSync(join(home, ".bash_profile"))).toBe(false);
  });

  it("says how to put it there by hand for a shell whose profile it does not know, and changes nothing", async () => {
    const { connections, home, choice } = setUp({ quaditOnPath: false, writableOnPath: false, shell: "/bin/tcsh" });
    const { cli } = await connections.state();
    expect(cli).toMatchObject({ linkInto: null, profile: null });
    expect(cli.manual).toContain("ln -s");
    expect(cli.manual).not.toContain("sudo");
    expect(await connections.planConnect(choice("codex"))).toEqual({
      ok: false,
      error: expect.stringContaining("ln -s"),
    });
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
});

posixOnly("Connect's agent tools on this computer", () => {
  it("finds none on a computer without any, and one by its config folder or its command on the login shell's PATH", async () => {
    const installed = async (connections: ReturnType<typeof setUp>["connections"]) =>
      (await connections.state()).harnesses.filter((h) => h.installed).map((h) => h.id);
    const bare = setUp();
    expect(await installed(bare.connections)).toEqual([]);

    const byFolder = setUp();
    mkdirSync(join(byFolder.home, ".claude"));
    expect(await installed(byFolder.connections)).toEqual(["claude"]);

    const byCommand = setUp();
    writeFileSync(join(byCommand.bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(byCommand.bin, "codex"), 0o755);
    expect(await installed(byCommand.connections)).toEqual(["codex"]);
  });

  it("tells Antigravity CLI from Gemini CLI, though both keep their files in ~/.gemini", async () => {
    const installed = async (connections: ReturnType<typeof setUp>["connections"]) =>
      (await connections.state()).harnesses.filter((h) => h.installed).map((h) => h.id);
    const antigravity = setUp();
    mkdirSync(join(antigravity.home, ".gemini", "antigravity-cli"), { recursive: true });
    expect(await installed(antigravity.connections)).toEqual(["antigravity"]);

    const gemini = setUp();
    mkdirSync(join(gemini.home, ".gemini"));
    writeFileSync(join(gemini.home, ".gemini", "settings.json"), "{}");
    expect(await installed(gemini.connections)).toEqual(["gemini"]);

    const byCommand = setUp();
    writeFileSync(join(byCommand.bin, "agy"), "#!/bin/sh\n");
    chmodSync(join(byCommand.bin, "agy"), 0o755);
    expect(await installed(byCommand.connections)).toEqual(["antigravity"]);
  });
});
