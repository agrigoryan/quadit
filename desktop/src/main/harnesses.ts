// The agent harnesses Connect knows, and what connecting each one changes
// on disk: where it reads skills, how its agent's commands get
// QUADIT_CONFIG (its own quadit login), how it may run quadit without
// asking, and its entry for Quadit's MCP server, which signs in through the
// harness's own OAuth and so holds only the address, never a token.
//
// Paths are those of macOS and Linux, under the home folder; the
// variables some harnesses read to move their config (CLAUDE_CONFIG_DIR,
// CODEX_HOME, XDG_CONFIG_HOME) are not followed: an app started from the
// Dock does not see them, and the plan shows every path it touches.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Change } from "@/main/config-edits";

export interface Harness {
  id: string;
  name: string;
  /** The letters on its tile, where the app shows tools as neutral tiles rather than their logos. */
  initials: string;
  /** Its command, looked for on the login shell's PATH. */
  command: string;
  /**
   * A folder or file of its own under the home folder, there when it is
   * installed. Never one another harness makes: Antigravity CLI lives in
   * ~/.gemini too, so Gemini CLI is known by its settings file.
   */
  trace: string;
  /** The skills folder it reads, under the home folder. */
  skills: string;
  /**
   * Whether an agent in it was seen to listen (desktop contract §11: the
   * skills pass, scripts/agent-listen-check.sh, docs/agents.md's table):
   * it held its waits and answered what came in. A tool not verified says
   * so on its card.
   */
  listenVerified: boolean;
  /**
   * The changes that set QUADIT_CONFIG=`config` for the commands its agent
   * runs. Only where its setting for that is documented and was seen to
   * reach those commands; without one, the quadit command in it works as
   * the computer's default login.
   */
  env?(home: string, config: string): Change[];
  /** The changes that let its agent run quadit without asking each time, and what that means. */
  allowCli?: { changes(home: string): Change[]; warning?: string };
  mcp?: {
    /** The changes that add Quadit's MCP server at `url`; `unattended`: its tools run without asking. */
    changes(home: string, url: string, unattended: boolean): Change[];
    /** How the person signs the harness in to the server. */
    signIn: string;
  };
}

export const HARNESSES: readonly Harness[] = [
  {
    id: "claude",
    initials: "CC",
    name: "Claude Code",
    command: "claude",
    trace: ".claude",
    skills: ".claude/skills",
    listenVerified: true,
    env: (home, config) => [
      { kind: "json", path: join(home, ".claude", "settings.json"), keyPath: ["env", "QUADIT_CONFIG"], value: config },
    ],
    allowCli: {
      changes: (home) => [
        {
          kind: "json-item",
          path: join(home, ".claude", "settings.json"),
          keyPath: ["permissions", "allow"],
          value: "Bash(quadit:*)",
        },
      ],
    },
    mcp: {
      changes: (home, url, unattended) => [
        {
          kind: "json",
          path: join(home, ".claude.json"),
          keyPath: ["mcpServers", "quadit"],
          value: { type: "http", url },
        },
        ...(unattended
          ? [
              {
                kind: "json-item" as const,
                path: join(home, ".claude", "settings.json"),
                keyPath: ["permissions", "allow"],
                value: "mcp__quadit",
              },
            ]
          : []),
      ],
      signIn: "In Claude Code, type /mcp, choose quadit and then Authenticate.",
    },
  },
  {
    id: "codex",
    initials: "CX",
    name: "Codex",
    command: "codex",
    trace: ".codex",
    skills: ".agents/skills",
    listenVerified: true,
    env: (home, config) => [
      {
        kind: "toml",
        path: join(home, ".codex", "config.toml"),
        table: ["shell_environment_policy", "set"],
        entries: { QUADIT_CONFIG: config },
      },
    ],
    allowCli: {
      changes: (home) => [
        {
          kind: "toml",
          path: join(home, ".codex", "config.toml"),
          table: ["sandbox_workspace_write"],
          entries: { network_access: true },
        },
      ],
      warning:
        "Codex's sandbox has no network unless it is let out, so quadit cannot reach the server from inside it. " +
        "Allowing it sets network_access = true for its sandbox: every command Codex runs there may then reach the network, not only quadit.",
    },
    mcp: {
      changes: (home, url) => [
        { kind: "toml", path: join(home, ".codex", "config.toml"), table: ["mcp_servers", "quadit"], entries: { url } },
      ],
      signIn: "In a terminal, run: codex mcp login quadit",
    },
  },
  {
    id: "gemini",
    initials: "Ge",
    name: "Gemini CLI",
    command: "gemini",
    trace: ".gemini/settings.json",
    skills: ".agents/skills",
    listenVerified: false,
    mcp: {
      changes: (home, url, unattended) => [
        {
          kind: "json",
          path: join(home, ".gemini", "settings.json"),
          keyPath: ["mcpServers", "quadit"],
          value: unattended ? { httpUrl: url, trust: true } : { httpUrl: url },
        },
      ],
      signIn: "In Gemini CLI, type /mcp auth quadit",
    },
  },
  {
    // Google's successor to Gemini CLI: its own command (agy), and its own
    // files under ~/.gemini, which Gemini CLI's settings.json does not reach.
    id: "antigravity",
    initials: "AG",
    name: "Antigravity CLI",
    command: "agy",
    trace: ".gemini/antigravity-cli",
    skills: ".gemini/config/skills",
    listenVerified: true,
    mcp: {
      changes: (home, url) => [
        {
          kind: "json",
          path: join(home, ".gemini", "config", "mcp_config.json"),
          keyPath: ["mcpServers", "quadit"],
          value: { url },
        },
      ],
      signIn: "In Antigravity CLI, type /mcp and sign in to quadit",
    },
  },
  {
    id: "cursor",
    initials: "Cu",
    name: "Cursor",
    command: "cursor-agent",
    trace: ".cursor",
    skills: ".agents/skills",
    listenVerified: false,
    mcp: {
      changes: (home, url) => [
        { kind: "json", path: join(home, ".cursor", "mcp.json"), keyPath: ["mcpServers", "quadit"], value: { url } },
      ],
      signIn: "In a terminal, run: cursor-agent mcp login quadit (the Cursor editor asks on first use).",
    },
  },
  {
    id: "opencode",
    initials: "oc",
    name: "opencode",
    command: "opencode",
    trace: ".config/opencode",
    skills: ".agents/skills",
    listenVerified: false,
    mcp: {
      changes: (home, url) => [
        { kind: "json", path: opencodeConfig(home), keyPath: ["mcp", "quadit"], value: { type: "remote", url } },
      ],
      signIn: "In a terminal, run: opencode mcp auth quadit",
    },
  },
  {
    id: "pi",
    name: "pi",
    initials: "pi",
    command: "pi",
    trace: ".pi",
    skills: ".agents/skills",
    listenVerified: false,
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    initials: "GH",
    command: "copilot",
    trace: ".copilot",
    skills: ".agents/skills",
    listenVerified: false,
  },
];

/** opencode reads opencode.jsonc when there is one, and opencode.json otherwise. */
function opencodeConfig(home: string): string {
  const folder = join(home, ".config", "opencode");
  const jsonc = join(folder, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(folder, "opencode.json");
}
