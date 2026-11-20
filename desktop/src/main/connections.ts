// Connect: setting up an agent harness (harnesses.ts) to work with a Quadit
// workspace, and taking it back. Two ways, either or both:
//   CLI + skill  the quadit command on the login shell's PATH (the app's
//                own copy linked there when there is none, in a folder of
//                the person's own put on the PATH by a line in their shell's
//                profile when no folder on it is theirs: quadit-cli.ts),
//                the skill where
//                the harness reads skills, and a quadit login for an agent
//                of the workspace: its own login, which the harness's
//                environment setting points QUADIT_CONFIG at, where it has
//                one known to work; the computer's default login otherwise;
//   MCP          Quadit's MCP server in the harness's settings, by address
//                only: the harness signs in through its own OAuth, where
//                the person picks the agent it works as.
//
// Nothing is written until the person has seen the plan (every file, as a
// diff, and where the backups go) and pressed Apply. A token is asked of the
// workspace's own page (an agent-token request), handed to `quadit login`
// on standard input, and kept nowhere else: the app's ledger holds only its
// id. The ledger (connections.json) records what each connection did, so
// Disconnect takes back exactly that where the file still says what was
// written. A change several connections need (the shared skill file, the
// default login, the link with its folder and profile line) is made once,
// shared, and taken back with the last of them.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Applied,
  backUp,
  type Change,
  changedSince,
  diffOf,
  EditRefused,
  type FileEdit,
  planChanges,
  planReverts,
  readText,
  realPath,
  sha256,
  targetOf,
  writeEdits,
} from "@/main/config-edits";
import { HARNESSES, type Harness } from "@/main/harnesses";
import type { QuaditCli } from "@/main/quadit-cli";
import type { DesktopOutcome, DesktopRequest, DesktopSummary } from "@/shared/bridge";
import type { ConnectChoice, ConnectMethod, ConnectView, Planned, PlanView } from "@/shared/pages-api";

export interface ConnectionsParts {
  home: string;
  /** The app's data folder: the ledger and the backups go there. */
  dataDir: string;
  platform: NodeJS.Platform;
  /** This computer's name, in the names of the tokens Connect makes. */
  hostName: string;
  cli: QuaditCli;
  /** The workspaces the server windows show now. */
  summaries(): { serverId: string; summary: DesktopSummary; listening: boolean }[];
  server(serverId: string): { name: string; origin: string } | undefined;
  /** Asks the page that speaks for a workspace (Requests.toWorkspace). */
  ask(serverId: string, workspaceId: string, request: DesktopRequest): Promise<DesktopOutcome>;
}

/** What Connect did for one harness. */
interface Connection {
  serverId: string;
  workspaceId: string;
  methods: ConnectMethod[];
  agent: { id: string; handle: string };
  edits: Applied[];
  /** The token behind the quadit login among the edits (its config file); revoked when that login is taken back. */
  token: { id: string; label: string; config: string; serverId: string; workspaceId: string } | null;
  at: number;
}

interface Ledger {
  harnesses: Record<string, Connection>;
}

type Plan =
  | {
      kind: "connect";
      id: string;
      harness: Harness;
      choice: ConnectChoice;
      origin: string;
      /** The agent chosen; null when it is to be made at Apply, or when no choice holds (worksAs). */
      agent: { id: string; handle: string; name: string } | null;
      /** Who the quadit command will work as when that is the default login already there, not the agent chosen. */
      worksAs: { id: string; handle: string } | null;
      edits: FileEdit[];
      applied: Applied[];
      /** Changes another connection made already, recorded for this one too. */
      shared: Applied[];
      sharedToken: Connection["token"];
      /** The login to make, when the plan has one. */
      login: { binary: string; config: string } | null;
      backupDir: string;
      warnings: string[];
    }
  | {
      kind: "disconnect";
      id: string;
      harness: Harness;
      edits: FileEdit[];
      notes: string[];
      revoke: Connection["token"];
      backupDir: string;
      warnings: string[];
    };

const MASKED_TOKEN = "qd_…";

export class Connections {
  private plans = new Map<string, Plan>();
  private ledgerFile: string;

  constructor(private parts: ConnectionsParts) {
    this.ledgerFile = join(parts.dataDir, "connections.json");
  }

  /** Where the backups of the files Connect changes go, one folder per Apply. */
  get backupsDir(): string {
    return join(this.parts.dataDir, "backups");
  }

  /** The harnesses, what each has connected, and where the quadit command stands. */
  async state(): Promise<ConnectView> {
    const { home, cli } = this.parts;
    const supported = this.parts.platform !== "win32";
    const look = supported ? await cli.look() : { path: [], found: null, linkInto: null };
    const binary = look.found?.path ?? cli.bundled;
    const defaultConfig = supported && binary ? await cli.defaultConfig(binary).catch(() => null) : null;
    const ledger = this.ledger();
    const defaultLogin =
      defaultConfig && binary && existsSync(defaultConfig)
        ? {
            server: savedServer(defaultConfig),
            agent: await cli.whoIs(binary, defaultConfig).then(
              (who) => `@${who.handle}`,
              () => null,
            ),
          }
        : null;
    return {
      supported,
      harnesses: HARNESSES.map((harness) => {
        const connection = ledger.harnesses[harness.id];
        return {
          id: harness.id,
          name: harness.name,
          installed: this.installed(harness, look.path),
          mcp: !!harness.mcp,
          cliIdentity: harness.env ? "own" : "default",
          connected: connection
            ? {
                methods: connection.methods,
                server: this.parts.server(connection.serverId)?.name ?? "a removed server",
                workspace: this.workspaceName(connection.serverId, connection.workspaceId),
                agent: `@${connection.agent.handle}`,
              }
            : null,
        };
      }),
      cli: {
        found: look.found?.path ?? null,
        version: look.found?.version ?? "",
        linkInto: look.found || !cli.bundled || !look.linkInto ? null : homely(home, look.linkInto.folder),
        profile:
          look.found || !cli.bundled || !look.linkInto?.profile ? null : homely(home, look.linkInto.profile.path),
        manual: look.found || (cli.bundled && look.linkInto) ? null : manualInstall(cli.bundled),
      },
      defaultLogin,
      claudePlugin: claudePluginInstalled(home),
    };
  }

  /** Whether `harness` is on this computer: its config folder in the home folder, or its command in a folder of `path`. */
  private installed(harness: Harness, path: string[]): boolean {
    return (
      existsSync(join(this.parts.home, harness.folder)) || path.some((dir) => existsSync(join(dir, harness.command)))
    );
  }

  /** Plans connecting a harness as the person chose; nothing is written. */
  async planConnect(choice: ConnectChoice): Promise<Planned> {
    try {
      return { ok: true, plan: this.view(await this.makeConnectPlan(choice)) };
    } catch (err) {
      if (err instanceof EditRefused) return { ok: false, error: err.message };
      throw err;
    }
  }

  private async makeConnectPlan(choice: ConnectChoice): Promise<Plan> {
    const { home, cli } = this.parts;
    if (this.parts.platform === "win32")
      throw new EditRefused(
        "Connecting agent tools is not available on Windows yet: it needs the quadit command, which has no Windows build.",
      );
    const harness = HARNESSES.find((h) => h.id === choice.harness);
    if (!harness) throw new EditRefused("There is no such harness.");
    const ledger = this.ledger();
    if (ledger.harnesses[harness.id])
      throw new EditRefused(`${harness.name} is connected already: disconnect it first.`);
    const methods = [...new Set(choice.methods)].filter((m) => m === "cli" || (m === "mcp" && harness.mcp));
    if (methods.length === 0) throw new EditRefused("Pick how to connect it.");
    const summary = this.parts
      .summaries()
      .find(
        (s) => s.serverId === choice.serverId && s.summary.workspace.id === choice.workspaceId && s.listening,
      )?.summary;
    const origin = this.parts.server(choice.serverId)?.origin;
    if (!summary || !origin) throw new EditRefused("Open that workspace in its server's window first.");
    // What another connection did already is shared with it, not done again.
    const others = this.recordsByTarget(ledger);
    const changes: Change[] = [];
    const warnings: string[] = [];
    let login: { binary: string; config: string } | null = null;
    let worksAs: { id: string; handle: string } | null = null;
    let sharedToken: Connection["token"] = null;
    if (methods.includes("cli")) {
      const look = await cli.look();
      const binary = look.found?.path ?? cli.bundled;
      if (!binary || (!look.found && !look.linkInto)) {
        throw new EditRefused(
          `The quadit command is not on your PATH. Put it there, then try again: ${manualInstall(cli.bundled)}`,
        );
      }
      // The command on PATH may be the link another connection made: this one needs it too, with the folder and
      // the profile line that came with it.
      const linked = look.found && others.get(targetOf({ kind: "link", path: look.found.path, target: "" }));
      if (linked && linked.kind === "link") {
        changes.push({ kind: "link", path: linked.path, target: linked.target });
        for (const record of others.values()) {
          if (record.kind === "folder" && record.path === dirname(linked.path)) changes.push(record);
          if (record.kind === "line") changes.push({ kind: "line", path: record.path, line: record.line });
        }
      } else if (!look.found && look.linkInto && cli.bundled) {
        const { folder, profile } = look.linkInto;
        changes.push({ kind: "folder", path: folder });
        changes.push({ kind: "link", path: join(folder, "quadit"), target: cli.bundled });
        if (profile) changes.push({ kind: "line", path: profile.path, line: profile.line });
      }
      // An older quadit has no `login --path` (nor `login URL -`): it is to be updated, not worked around.
      const tooOld = (err: Error) => {
        throw new EditRefused(`${binary} is older than this app and cannot be connected: update it. (${err.message})`);
      };
      changes.push({
        kind: "file",
        path: join(home, harness.skills, "quadit", "SKILL.md"),
        content: await cli.skill(binary).catch(tooOld),
      });
      const defaultConfig = await cli.defaultConfig(binary).catch(tooOld);
      const shown = `${JSON.stringify({ url: origin, token: MASKED_TOKEN }, null, 2)}\n`;
      if (harness.env) {
        const config = join(dirname(defaultConfig), `${harness.id}.json`);
        changes.push({ kind: "written-by", path: config, shown }, ...harness.env(home, config));
        login = { binary, config };
      } else if (existsSync(defaultConfig)) {
        // The login there holds whatever agent is chosen here: the plan says whom it is, and records that.
        const who = await cli.whoIs(binary, defaultConfig).catch((err: Error) => {
          throw new EditRefused(
            `The default login (${defaultConfig}) did not say who it is, so Connect cannot tell whom ${harness.name} would work as: ${err.message}`,
          );
        });
        worksAs = { id: who.id, handle: who.handle };
        const made = others.has(targetOf({ kind: "written-by", path: defaultConfig, shown }));
        warnings.push(
          `${harness.name} has no setting the app can use to give quadit its own login, so there quadit works as this ` +
            `computer's default login: @${who.handle} on ${savedServer(defaultConfig) ?? "its server"}. ` +
            (made ? "Connect made that login for another harness." : "Connect leaves that login as it is.") +
            (harness.mcp ? " Connect it by MCP to give it an agent of its own." : ""),
        );
        if (made) {
          changes.push({ kind: "written-by", path: defaultConfig, shown });
          const config = realPath(defaultConfig);
          sharedToken = Object.values(ledger.harnesses).find((c) => c.token?.config === config)?.token ?? null;
        }
      } else {
        warnings.push(
          `${harness.name} has no setting the app can use to give quadit its own login, so there quadit works as ` +
            `this computer's default login (${defaultConfig}), made now for the agent chosen.` +
            (harness.mcp ? " Connect it by MCP to give it an agent of its own." : ""),
        );
        changes.push({ kind: "written-by", path: defaultConfig, shown });
        login = { binary, config: defaultConfig };
      }
      if (choice.allowUnattended && harness.allowCli) {
        changes.push(...harness.allowCli.changes(home));
        if (harness.allowCli.warning) warnings.push(harness.allowCli.warning);
      }
    }
    if (methods.includes("mcp") && harness.mcp) {
      changes.push(...harness.mcp.changes(home, `${origin}/mcp`, choice.allowUnattended));
    }
    if (harness.id === "claude" && claudePluginInstalled(home)) {
      warnings.push(
        "The Quadit plugin for Claude Code is installed. Its MCP entry needs QUADIT_URL and QUADIT_TOKEN in the environment, " +
          "which Connect does not set: turn the plugin off in Claude Code (/plugin) when you connect here.",
      );
    }

    // An agent is chosen only where the choice holds: not for the quadit command alone on a default login already there.
    let agent: { id: string; handle: string; name: string } | null = null;
    if (!worksAs || methods.includes("mcp")) {
      if (!choice.agent) throw new EditRefused("Pick an agent you may connect as.");
      if ("create" in choice.agent) {
        if (!summary.me.canCreateAgents) throw new EditRefused("You may not make agents in this workspace.");
        if (!choice.agent.create.name.trim() || !choice.agent.create.handle.trim()) {
          throw new EditRefused("Give the new agent a name and a handle.");
        }
      } else {
        const id = choice.agent.id;
        agent = summary.agents.find((a) => a.id === id && a.usable) ?? null;
        if (!agent) throw new EditRefused("Pick an agent you may connect as.");
      }
    }

    const own = changes.filter((change) => !others.has(targetOf(change)));
    const shared = changes.flatMap((change) => others.get(targetOf(change)) ?? []);
    const { edits, applied } = planChanges(own);
    const plan: Plan = {
      kind: "connect",
      id: randomBytes(9).toString("base64url"),
      harness,
      choice: { ...choice, methods },
      origin,
      agent,
      worksAs,
      edits,
      applied,
      shared,
      sharedToken,
      login,
      backupDir: this.backupDir(harness.id),
      warnings,
    };
    // One outstanding plan: a new one replaces any other.
    this.plans.clear();
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Drops the outstanding plan (its page cancelled it or closed). */
  dropPlans() {
    this.plans.clear();
  }

  /** Carries out a connect plan the person saw; it is good for one Apply. */
  async applyConnect(planId: string): Promise<{ ok: true; hint: string } | { ok: false; error: string }> {
    const plan = this.plans.get(planId);
    this.plans.delete(planId);
    if (plan?.kind !== "connect") return { ok: false, error: "That plan is gone: review the changes again." };
    const changed = changedSince(plan.edits);
    if (changed) return { ok: false, error: `${changed.path} changed since you reviewed the plan: review it again.` };
    const { choice, harness } = plan;
    const ask = (request: DesktopRequest) => this.parts.ask(choice.serverId, choice.workspaceId, request);

    let agent = plan.agent;
    if (!agent && choice.agent && "create" in choice.agent) {
      const made = await ask({ kind: "agent", create: choice.agent.create });
      if (!made.ok || !made.agent) return { ok: false, error: made.ok ? "The agent was not made." : made.message };
      agent = made.agent;
    }
    const worksAs = plan.worksAs ?? agent;
    if (!worksAs) return { ok: false, error: "Pick an agent you may connect as." };

    const backups = backUp(plan.edits, plan.backupDir);
    let token = plan.sharedToken;
    if (plan.login) {
      const label = `${harness.name} on ${this.parts.hostName}`;
      const issued = await ask({ kind: "agent-token", agent: worksAs.id, label });
      if (!issued.ok || !issued.token) return { ok: false, error: issued.ok ? "No token was made." : issued.message };
      try {
        await this.parts.cli.login(plan.login.binary, plan.origin, issued.token.secret, plan.login.config);
      } catch (err) {
        void ask({ kind: "revoke-token", token: issued.token.id });
        return { ok: false, error: (err as Error).message };
      }
      token = {
        id: issued.token.id,
        label,
        config: realPath(plan.login.config),
        serverId: choice.serverId,
        workspaceId: choice.workspaceId,
      };
    }
    writeEdits(plan.edits);
    const link = plan.applied.find((record) => record.kind === "link");
    if (link) this.parts.cli.linked(link.path);

    const records = plan.applied.map((record) =>
      record.kind === "file"
        ? { ...record, sha256: sha256(readText(record.path) ?? ""), backup: backups.get(record.path) ?? null }
        : record,
    );
    const ledger = this.ledger();
    ledger.harnesses[harness.id] = {
      serverId: choice.serverId,
      workspaceId: choice.workspaceId,
      methods: choice.methods,
      agent: { id: worksAs.id, handle: worksAs.handle },
      edits: [...records, ...plan.shared],
      token,
      at: Date.now(),
    };
    this.saveLedger(ledger);
    const hint = connectedHint(harness, choice.methods, worksAs.handle, agent?.handle ?? worksAs.handle);
    // The login PATH changed (a folder of the person's own, or the line that puts it there): open terminals keep the old one.
    const newPath = plan.applied.some((record) => record.kind === "line" || record.kind === "folder");
    return {
      ok: true,
      hint: newPath ? `${hint} Terminals opened from now on find quadit; reopen any that are open now.` : hint,
    };
  }

  /** Plans taking back what Connect did for a harness, where its files still say what was written. */
  planDisconnect(harnessId: string): Planned {
    const harness = HARNESSES.find((h) => h.id === harnessId);
    const ledger = this.ledger();
    const connection = ledger.harnesses[harnessId];
    if (!harness || !connection) return { ok: false, error: "It is not connected." };
    const others = this.targets(ledger, harnessId);
    try {
      const { edits, notes } = planReverts(connection.edits.filter((record) => !others.has(targetOf(record))));
      const token = connection.token;
      const revoke = token && !others.has(targetOf({ kind: "file", path: token.config, content: "" })) ? token : null;
      const plan: Plan = {
        kind: "disconnect",
        id: randomBytes(9).toString("base64url"),
        harness,
        edits,
        notes,
        revoke,
        backupDir: this.backupDir(harness.id),
        warnings: [
          ...notes,
          ...(revoke ? [`The token “${revoke.label}” is revoked on the server.`] : []),
          ...(connection.methods.includes("mcp")
            ? [
                `${harness.name} keeps its own sign-in to Quadit's MCP server: sign it out there, or revoke it on the server.`,
              ]
            : []),
        ],
      };
      this.plans.clear();
      this.plans.set(plan.id, plan);
      return { ok: true, plan: this.view(plan) };
    } catch (err) {
      if (err instanceof EditRefused) return { ok: false, error: err.message };
      throw err;
    }
  }

  async applyDisconnect(planId: string): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }> {
    const plan = this.plans.get(planId);
    this.plans.delete(planId);
    if (plan?.kind !== "disconnect") return { ok: false, error: "That plan is gone: review the changes again." };
    const changed = changedSince(plan.edits);
    if (changed) return { ok: false, error: `${changed.path} changed since you reviewed the plan: review it again.` };
    backUp(plan.edits, plan.backupDir);
    writeEdits(plan.edits);
    const ledger = this.ledger();
    delete ledger.harnesses[plan.harness.id];
    this.saveLedger(ledger);
    const notes = [...plan.notes];
    if (plan.revoke) {
      const revoked = await this.parts.ask(plan.revoke.serverId, plan.revoke.workspaceId, {
        kind: "revoke-token",
        token: plan.revoke.id,
      });
      if (!revoked.ok) {
        const server = this.parts.server(plan.revoke.serverId)?.name ?? "the server";
        notes.push(`Revoke the token “${plan.revoke.label}” yourself in ${server}'s settings: ${revoked.message}`);
      }
    }
    return { ok: true, notes };
  }

  private view(plan: Plan): PlanView {
    const files = plan.edits.map((edit) => ({
      path: edit.path,
      diff: diffOf(edit),
      ...(edit.writtenBy
        ? { note: "Written by quadit login, which checks the token with the server first. The token is shown masked." }
        : {}),
    }));
    if (plan.kind === "connect") {
      for (const record of plan.shared) {
        files.push({
          path: record.path,
          diff: "",
          note: "Done already for another connected harness; shared with it.",
        });
      }
    }
    return { id: plan.id, files, backupDir: plan.backupDir, warnings: plan.warnings };
  }

  private workspaceName(serverId: string, workspaceId: string): string {
    return (
      this.parts.summaries().find((s) => s.serverId === serverId && s.summary.workspace.id === workspaceId)?.summary
        .workspace.name ?? ""
    );
  }

  /** The targets of every connection's records but `except`'s. */
  private targets(ledger: Ledger, except: string | null): Set<string> {
    const found = new Set<string>();
    for (const [id, connection] of Object.entries(ledger.harnesses)) {
      if (id !== except) for (const record of connection.edits) found.add(targetOf(record));
    }
    return found;
  }

  private recordsByTarget(ledger: Ledger): Map<string, Applied> {
    const found = new Map<string, Applied>();
    for (const connection of Object.values(ledger.harnesses)) {
      for (const record of connection.edits) found.set(targetOf(record), record);
    }
    return found;
  }

  private backupDir(harnessId: string): string {
    return join(this.backupsDir, `${new Date().toISOString().replaceAll(":", "-")}-${harnessId}`);
  }

  private ledger(): Ledger {
    try {
      const parsed = JSON.parse(readFileSync(this.ledgerFile, "utf8")) as Partial<Ledger>;
      if (parsed.harnesses && typeof parsed.harnesses === "object") return { harnesses: parsed.harnesses };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`${this.ledgerFile} cannot be read`, { cause: err });
    }
    return { harnesses: {} };
  }

  private saveLedger(ledger: Ledger) {
    mkdirSync(dirname(this.ledgerFile), { recursive: true });
    const next = `${this.ledgerFile}.next`;
    writeFileSync(next, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    renameSync(next, this.ledgerFile);
  }
}

/** What the person does next, once connected. */
function connectedHint(harness: Harness, methods: ConnectMethod[], cliAs: string, mcpAs: string): string {
  const lines = [`Start a new ${harness.name} session to pick up the changes.`];
  if (methods.includes("cli")) {
    lines.push(
      harness.env
        ? `There the quadit command works as @${cliAs}.`
        : `There the quadit command works as this computer's default login, @${cliAs}.`,
    );
  }
  if (methods.includes("mcp") && harness.mcp) lines.push(`${harness.mcp.signIn} When it asks, work as @${mcpAs}.`);
  return lines.join(" ");
}

/**
 * How to put the quadit command on PATH by hand: the app's copy linked into
 * a folder of the person's own (a shell whose profile the app does not
 * know), or, without one, the install script. Neither needs an administrator.
 */
function manualInstall(bundled: string | null): string {
  return bundled
    ? `mkdir -p ~/.local/bin && ln -s '${bundled}' ~/.local/bin/quadit, then add ~/.local/bin to your PATH`
    : "curl -fsSL https://raw.githubusercontent.com/agrigoryan/quadit/main/install.sh | sh";
}

/** `path` as a person writes it: ~ for the home folder. */
function homely(home: string, path: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The server a quadit config file is for (never its token), or null when it says none. */
function savedServer(config: string): string | null {
  try {
    const { url } = JSON.parse(readFileSync(config, "utf8")) as { url?: unknown };
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

/** Whether Claude Code has the Quadit plugin (a plugin named quadit, from any marketplace). */
function claudePluginInstalled(home: string): boolean {
  try {
    const { plugins } = JSON.parse(
      readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"),
    ) as {
      plugins?: Record<string, unknown>;
    };
    return Object.keys(plugins ?? {}).some((name) => name.startsWith("quadit@"));
  } catch {
    return false;
  }
}
