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
  /**
   * The changes that let its agent run quadit without asking each time,
   * which Connect always makes (desktop contract §11, second amendment: the
   * owner's "max permissive by default"), and `said`, the plain statement of
   * what they let it do, shown with the files. `quadit` is the absolute path
   * of the quadit command on the PATH, as an agent may call it; null when
   * there is none.
   */
  allowCli?: { changes(home: string, quadit: string | null): Change[]; said: string }[];
  /** Said with the files when the app runs it by itself with its permission checks off (its one-prompt form needs that). */
  selfRunSaid?: string;
  mcp?: {
    /** The changes that add Quadit's MCP server at `url`. */
    changes(home: string, url: string): Change[];
    /** The changes that let its agent use Quadit's MCP tools without asking, always made with the server's, and what they let it do. */
    allow?: { changes(home: string, url: string): Change[]; said: string };
    /** How the person signs the harness in to the server. */
    signIn: string;
  };
  /**
   * Its one-prompt command's arguments for `prompt` (desktop contract §11,
   * third amendment): the app runs it to give a connect code back and to
   * answer an inbox item. An argument list, never a shell's line. Absent
   * where the form is not confirmed: such a tool keeps the line to paste.
   */
  oneShot?: (prompt: string) => string[];
  /**
   * Where its desktop app carries a copy of its program, for when it is not
   * on the login shell's PATH: under an applications folder (`apps`) or the
   * home folder (`home`), `*` standing for any one folder's name. Found
   * there in 2026 and documented nowhere, so looked for, never assumed.
   */
  appCopies?: { apps?: string; home?: string }[];
  /** Where it keeps command rules the app adds to (allowCli), under the home folder: so a plan names them plainly. */
  rules?: { folder: string; file: string };
}

export const HARNESSES: readonly Harness[] = [
  {
    id: "claude",
    initials: "CC",
    name: "Claude Code",
    command: "claude",
    trace: ".claude",
    oneShot: (prompt) => ["-p", prompt],
    appCopies: [{ home: "Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude" }],
    skills: ".claude/skills",
    listenVerified: true,
    env: (home, config) => [
      { kind: "json", path: join(home, ".claude", "settings.json"), keyPath: ["env", "QUADIT_CONFIG"], value: config },
    ],
    allowCli: [
      {
        changes: (home) => [
          {
            kind: "json-item",
            path: join(home, ".claude", "settings.json"),
            keyPath: ["permissions", "allow"],
            value: "Bash(quadit:*)",
          },
        ],
        said: "Claude Code may run quadit commands without asking.",
      },
    ],
    mcp: {
      changes: (home, url) => [
        {
          kind: "json",
          path: join(home, ".claude.json"),
          keyPath: ["mcpServers", "quadit"],
          value: { type: "http", url },
        },
      ],
      allow: {
        changes: (home) => [
          {
            kind: "json-item",
            path: join(home, ".claude", "settings.json"),
            keyPath: ["permissions", "allow"],
            value: "mcp__quadit",
          },
        ],
        said: "Claude Code may use Quadit's MCP tools without asking.",
      },
      signIn: "In Claude Code, type /mcp, choose quadit and then Authenticate.",
    },
  },
  {
    id: "codex",
    initials: "CX",
    name: "Codex",
    command: "codex",
    trace: ".codex",
    oneShot: (prompt) => ["exec", "--skip-git-repo-check", prompt],
    appCopies: [{ apps: "ChatGPT.app/Contents/Resources/codex-cli/bin/codex" }],
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
    // Two settings: its sandbox may reach the network (quadit cannot reach the server from inside it otherwise), and
    // a command rule per way an agent calls quadit, which Codex runs outside the sandbox without asking
    // (`codex execpolicy check --rules FILE -- quadit me` says "allow" for each). A command wrapped in a shell
    // (`zsh -lc "quadit …"`) matches no rule: there the sandbox's network is what lets quadit work.
    allowCli: [
      {
        changes: (home) => [
          {
            kind: "toml",
            path: join(home, ".codex", "config.toml"),
            table: ["sandbox_workspace_write"],
            entries: { network_access: true },
            // The person may have this table already (its writable roots): the network goes into it.
            intoExisting: true,
          },
        ],
        said: "Codex's sandbox may reach the network, for every command it runs, not only quadit.",
      },
      {
        changes: (home, quadit) => [
          { kind: "folder", path: join(home, ".codex", "rules") },
          ...["quadit", ...(quadit ? [quadit] : [])].map((command) => ({
            kind: "line" as const,
            path: join(home, ".codex", "rules", "default.rules"),
            line: codexRule(command),
          })),
        ],
        said: "Codex may run quadit without asking.",
      },
    ],
    rules: { folder: ".codex/rules", file: ".codex/rules/default.rules" },
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
    // No one-prompt form the app runs: whether `gemini -p` runs quadit, with no one there to approve a shell
    // command and without a flag that turns every check off, is not confirmed. Its card keeps the line to paste.
    skills: ".agents/skills",
    listenVerified: false,
    mcp: {
      changes: (home, url) => [
        {
          kind: "json",
          path: join(home, ".gemini", "settings.json"),
          keyPath: ["mcpServers", "quadit"],
          value: { httpUrl: url },
        },
      ],
      allow: {
        changes: (home, url) => [
          {
            kind: "json",
            path: join(home, ".gemini", "settings.json"),
            keyPath: ["mcpServers", "quadit"],
            value: { httpUrl: url, trust: true },
          },
        ],
        said: "Gemini CLI may use Quadit's MCP tools without asking.",
      },
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
    oneShot: (prompt) => ["-p", prompt, "--dangerously-skip-permissions"],
    selfRunSaid: "Quadit runs Antigravity CLI by itself to answer, with its permission checks off for those runs.",
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
    oneShot: (prompt) => ["-p", "--force", prompt],
    selfRunSaid: "Quadit runs Cursor by itself to answer, with its permission checks off for those runs.",
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

/**
 * A Codex command rule that lets `command` (and whatever follows it) run
 * without asking, with the app's mark, so Disconnect takes out exactly it.
 */
function codexRule(command: string): string {
  return `prefix_rule(pattern=[${JSON.stringify(command)}], decision="allow")  # Added by the Quadit app: Disconnect in the app takes it out.`;
}
