// Connect: setting up an agent harness (harnesses.ts) to work with a Quadit
// workspace, and taking it back. Two ways, either or both:
//   CLI + skill  the quadit command on the login shell's PATH (the app's
//                own copy linked there when there is none), the skill where
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
// default login, the link) is made once, shared, and taken back with the
// last of them.

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
      /** The agent to work as; null when it is to be made at Apply. */
      agent: { id: string; handle: string; name: string } | null;
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
    const owned = this.targets(ledger, null);
    return {
      supported,
      harnesses: HARNESSES.map((harness) => {
        const connection = ledger.harnesses[harness.id];
        return {
          id: harness.id,
          name: harness.name,
          installed:
            existsSync(join(home, harness.folder)) || look.path.some((dir) => existsSync(join(dir, harness.command))),
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
        linkInto: look.found || !cli.bundled ? null : look.linkInto,
        manual: look.found || (cli.bundled && look.linkInto) ? null : manualInstall(cli.bundled),
      },
      defaultLogin:
        defaultConfig && !owned.has(targetOf({ kind: "file", path: defaultConfig, content: "" }))
          ? savedServer(defaultConfig)
          : null,
      claudePlugin: claudePluginInstalled(home),
    };
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
      throw new EditRefused("Connect needs the quadit command, which has no Windows build yet.");
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
    let agent: { id: string; handle: string; name: string } | null = null;
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

    // What another connection did already is shared with it, not done again.
    const others = this.recordsByTarget(ledger);
    const changes: Change[] = [];
    const warnings: string[] = [];
    let login: { binary: string; config: string } | null = null;
    if (methods.includes("cli")) {
      const look = await cli.look();
      const binary = look.found?.path ?? cli.bundled;
      if (!binary || (!look.found && !look.linkInto)) {
        throw new EditRefused(
          `The quadit command is not on your PATH. Install it, then try again: ${manualInstall(cli.bundled)}`,
        );
      }
      // The command on PATH may be the link another connection made: this one needs it too.
      const linked = look.found && others.get(targetOf({ kind: "link", path: look.found.path, target: "" }));
      if (linked && linked.kind === "link") changes.push({ kind: "link", path: linked.path, target: linked.target });
      else if (!look.found && look.linkInto && cli.bundled) {
        changes.push({ kind: "link", path: join(look.linkInto, "quadit"), target: cli.bundled });
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
      } else {
        warnings.push(
          `${harness.name} has no setting the app can use to give quadit its own login, so there quadit works as ` +
            `this computer's default login (${defaultConfig}). Connect it by MCP to give it an agent of its own.`,
        );
        if (!existsSync(defaultConfig) || others.has(targetOf({ kind: "written-by", path: defaultConfig, shown }))) {
          changes.push({ kind: "written-by", path: defaultConfig, shown });
          login = { binary, config: defaultConfig };
        } else {
          warnings.push(
            `The default login is there already (${savedServer(defaultConfig) ?? "unknown server"}) and Connect leaves it as it is.`,
          );
        }
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

    const own = changes.filter((change) => !others.has(targetOf(change)));
    const shared = changes.flatMap((change) => others.get(targetOf(change)) ?? []);
    let sharedToken: Connection["token"] = null;
    if (login && others.has(targetOf({ kind: "written-by", path: login.config, shown: "" }))) {
      sharedToken =
        Object.values(ledger.harnesses).find((c) => c.token?.config === realPath(login?.config ?? ""))?.token ?? null;
      login = null;
    }
    const { edits, applied } = planChanges(own);
    const plan: Plan = {
      kind: "connect",
      id: randomBytes(9).toString("base64url"),
      harness,
      choice: { ...choice, methods },
      origin,
      agent,
      edits,
      applied,
      shared,
      sharedToken,
      login,
      backupDir: this.backupDir(harness.id),
      warnings,
    };
    this.plans.set(plan.id, plan);
    return plan;
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
    if (!agent && "create" in choice.agent) {
      const made = await ask({ kind: "agent", create: choice.agent.create });
      if (!made.ok || !made.agent) return { ok: false, error: made.ok ? "The agent was not made." : made.message };
      agent = made.agent;
    }
    if (!agent) return { ok: false, error: "Pick an agent you may connect as." };

    const backups = backUp(plan.edits, plan.backupDir);
    let token = plan.sharedToken;
    if (plan.login) {
      const label = `${harness.name} on ${this.parts.hostName}`;
      const issued = await ask({ kind: "agent-token", agent: agent.id, label });
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
      agent: { id: agent.id, handle: agent.handle },
      edits: [...records, ...plan.shared],
      token,
      at: Date.now(),
    };
    this.saveLedger(ledger);
    return { ok: true, hint: connectedHint(harness, choice.methods, agent.handle) };
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
function connectedHint(harness: Harness, methods: ConnectMethod[], handle: string): string {
  const lines = [`Start a new ${harness.name} session to pick up the changes.`];
  if (methods.includes("cli")) {
    lines.push(
      harness.env
        ? `There the quadit command works as @${handle}.`
        : "There the quadit command works as this computer's default login.",
    );
  }
  if (methods.includes("mcp") && harness.mcp) lines.push(`${harness.mcp.signIn} When it asks, work as @${handle}.`);
  return lines.join(" ");
}

/** How to put the quadit command on PATH by hand. */
function manualInstall(bundled: string | null): string {
  return bundled ? `sudo ln -s '${bundled}' /usr/local/bin/quadit` : "brew install agrigoryan/tap/quadit";
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
