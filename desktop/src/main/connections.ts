// Connect: setting up an agent harness (harnesses.ts) to work with a Quadit
// workspace, and taking it back. Two ways, either or both:
//   CLI + skill  the quadit command on the login shell's PATH (the app's
//                own copy linked there when there is none, in a folder of
//                the person's own put on the PATH by a line in their shell's
//                profile when no folder on it is theirs; on Windows the
//                folder of the app's quadit.exe added to the person's PATH:
//                quadit-cli.ts),
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
// id. The ledger (connections.json) records what each tool's connecting did,
// so Disconnect takes back exactly that where the file still says what was
// written. A change several tools need (the shared skill file, the default
// login, the link with its folder and profile line) is made once, shared,
// and taken back with the last of them. A harness whose Windows places are
// not known (harnesses.ts, notOnWindows) is not offered there.
//
// One tool works in several workspaces, of one server or several, at once
// (multi-workspace design §3.6): the ledger has, for each tool, what was
// changed for the tool itself (its settings, its skill, what lets it use
// Quadit without asking, its first login), and one connection for each
// workspace, each with a login of its own, a token the app made for it, its
// code and whether the app ran it. "Connect here as well" adds a workspace:
// `quadit login` with the tool's own QUADIT_CONFIG, which keeps the new
// login in a file of its own beside the first and lists both in the
// command's index (login-index.ts); nothing of the tool's own changes. Every
// call about a connection names it whole (ConnectionRef: the tool, the
// server, the workspace and the agent), never by its tool or its login
// file alone, so one about a workspace never reaches another. Disconnect
// takes back one connection: its runs, its token and its login (one the app
// made); what was changed for the tool goes with its last. Folder ties are
// the workspace's, shared by every tool there: Disconnect leaves them (the
// card's Folders unties one). A quadit older than this has none of it, and
// is refused for a second workspace (quadit-cli.ts,
// knowsWorkspaces). The MCP entry stays with the first workspace.
//
// Written is not connected (desktop contract §11): a tool connected through
// the quadit command, as an agent of the workspace, gets a connect code
// (asked of the workspace's page, kept in the ledger so that its line can be
// shown again), which the agent gives back from inside the tool to prove the
// connection; where it stands is asked of the page again whenever the
// person's page wants it (handshake.ts). A server is only ever asked about
// an agent of its own: a tool that works as a login of another workspace
// (the computer's default one) is never asked about.
//
// The skill Connect writes is the one the app's own quadit carries (the one
// that runs agents for Run by Quadit, updated with the app), else the one on
// the PATH: a run Quadit starts needs the skill's section for it, which an
// older quadit on the PATH may not carry. At every start, a skill file that
// still says what Connect wrote is rewritten through the same plan, backup
// and ledger, so Disconnect still takes back exactly what is there; one the
// person changed since is left, and its tool says so (refresh).
//
// What lets a tool use Quadit without asking (its allow entries, Codex's
// command rules and sandbox network: harnesses.ts) is written by every
// Connect, shown with the files in plain words, and taken back by
// Disconnect; a tool connected by a version from before is brought up to it
// once, at a start (refresh), and never again after the person takes one away.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import {
  type Applied,
  backUp,
  USER_PATH,
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
import { CODE_LIFE_MS, handshakeOf, type OpenCode } from "@/main/handshake";
import { HARNESSES, type Harness } from "@/main/harnesses";
import { type LoginIndex, loginsOf, readIndex } from "@/main/login-index";
import { findCommand, type QuaditCli } from "@/main/quadit-cli";
import { type DesktopOutcome, type DesktopRequest, type DesktopSummary, isConnectCode } from "@/shared/bridge";
import type {
  ConnectChoice,
  ConnectionRef,
  ConnectionView,
  ConnectMethod,
  ConnectView,
  FileRole,
  PlanFile,
  Planned,
  Disconnected,
  Handshake,
  PlanView,
  Refused,
  RunProgram,
  Unrevoked,
} from "@/shared/pages-api";

export interface ConnectionsParts {
  home: string;
  /** The app's data folder: the ledger and the backups go there. */
  dataDir: string;
  platform: NodeJS.Platform;
  /** This computer's name, in the names of the tokens Connect makes. */
  hostName: string;
  cli: QuaditCli;
  /** The quadit the app carries (runner.ts runs it), whose skill Connect writes; null in a build without one. */
  ownQuadit(): string | null;
  /** The workspaces the server windows show now. */
  summaries(): { serverId: string; summary: DesktopSummary; listening: boolean }[];
  server(serverId: string): { name: string; origin: string } | undefined;
  /** The app's server at the address `origin`, by its id; null when the app has none there. */
  serverAt(origin: string): string | null;
  /**
   * The app to mark a login with (its executable), for the server the app
   * runs on this computer, so that the quadit command may start the app
   * when that server is not running; null for any other server.
   */
  appFor(serverId: string): string | null;
  /**
   * A connection was made, or given a new code (`code`: the open one, null
   * when none was made): the app may run its tool to give the code back.
   * `key` names it (connectionKey).
   */
  connected(key: string, code: string | null): void;
  /** A connection was taken back: what the app ran for it stops. */
  disconnected(key: string): void;
  /**
   * Stops Quadit running the agent `agent` of the workspace `workspace` on
   * the server at `server` for any project on this computer (`quadit run
   * remove`, agent-runs-contract.md §8.2): its runs end and the server is
   * told, while the login still works. Never another workspace's or agent's,
   * whatever login file they share. `pending`: the runner is still telling
   * the server how a run ended.
   */
  removeRuns(of: {
    server: string;
    workspace: string;
    agent: string;
  }): Promise<{ ok: true } | (Refused & { pending?: true })>;
  /** Asks the page that speaks for a workspace (Requests.toWorkspace). */
  ask(serverId: string, workspaceId: string, request: DesktopRequest): Promise<DesktopOutcome>;
}

/** What Connect did for one harness: what it changed for the tool itself, and each workspace it works in. */
interface ToolRecord {
  /** What was changed for the tool itself (its first login among them), shared by its connections; taken back with the last. */
  edits: Applied[];
  /**
   * The tool's base login, real path: the file its settings point
   * QUADIT_CONFIG at, or, for a tool without such a setting, the computer's
   * default login. Absent: the computer's default login, wherever the
   * quadit command keeps it (a ledger from before it was kept).
   */
  base?: string;
  /**
   * What lets the tool use Quadit without asking was written for it (at
   * Connect, or once at a start since): it is not written again, even after
   * the person takes it away. Absent in ledgers from before.
   */
  allowed?: boolean;
  connections: Connection[];
}

/** The tool in one workspace. */
interface Connection {
  serverId: string;
  workspaceId: string;
  /** The workspace's name when it was connected, said once no window shows it ("" in a ledger from before). */
  workspaceName: string;
  methods: ConnectMethod[];
  /** Whom the quadit command works as there. */
  agent: { id: string; handle: string };
  /** Its login file, real path, when it is not the tool's base login (a second workspace's: the index lists it). */
  login?: string;
  /** The token the app made for that login (shared with a tool that shares the login); null when the login is not the app's. */
  token: { id: string; label: string } | null;
  /**
   * The agent of the workspace the tool works as there, which alone is
   * given codes and asked about; null when it works as a login the app may
   * not ask that workspace about.
   */
  member: { id: string; handle: string } | null;
  /** The connect code open for `member` here, until it is given back. */
  code: OpenCode | null;
  /** The app ran the tool and saw it give its connect code back (self-runs.ts): it is not run for that again. */
  ran?: true;
  at: number;
}

interface Ledger {
  harnesses: Record<string, ToolRecord>;
}

/** A tool's one connection as a ledger from before several workspaces has it. */
interface OldConnection {
  serverId: string;
  workspaceId: string;
  methods: ConnectMethod[];
  agent: { id: string; handle: string };
  edits: Applied[];
  token: { id: string; label: string; config: string } | null;
  member?: { id: string; handle: string } | null;
  code?: OpenCode | null;
  allowed?: boolean;
  ran?: true;
  at: number;
}

type ConnectPlan = {
  kind: "connect";
  id: string;
  harness: Harness;
  choice: ConnectChoice;
  origin: string;
  workspaceName: string;
  /** The tool worked in another workspace when the plan was made (Connect here as well): nothing of its own changes. */
  toolThere: boolean;
  /** The agent chosen; null when it is to be made at Apply, or when no choice holds (worksAs). */
  agent: { id: string; handle: string; name: string } | null;
  /** Who the quadit command will work as when that is a login there already (its file), not the agent chosen. */
  worksAs: { id: string; handle: string; login: string } | null;
  edits: FileEdit[];
  applied: Applied[];
  /** Changes another tool made already, recorded for this one too. */
  shared: Applied[];
  /** The token behind the login the tool will share with another tool, when the app made it. */
  sharedToken: Connection["token"];
  /** The login to make, when the plan has one: into the tool's base login (`base`), the quadit command choosing the file. */
  login: { binary: string } | null;
  base: string | null;
  backupDir: string;
  warnings: string[];
};

type DisconnectPlan = {
  kind: "disconnect";
  id: string;
  harness: Harness;
  ref: ConnectionRef;
  workspaceName: string;
  /** The tool's last connection: what was changed for the tool goes too. */
  last: boolean;
  edits: FileEdit[];
  notes: string[];
  revoke: Connection["token"];
  /** The handle of the agent the connection worked as, whose token `revoke` is. */
  agent: string;
  /** The login file the plan takes away, for the plan's words; null without one. */
  loginPath: string | null;
  /** The index lists the login: `quadit logout` takes it away, file and entry. */
  logout: { binary: string; base: string } | null;
  backupDir: string;
  warnings: string[];
};

type Plan = ConnectPlan | DisconnectPlan;

const MASKED_TOKEN = "qd_…";

/** The heading of the skill's section for a run Quadit starts (integrations/skills/quadit/SKILL.md). */
const RUN_SECTION = "## Started by Quadit";

/** How a connection is named where a string is wanted (the runs the app does by itself, the maps here). */
export function connectionKey(ref: ConnectionRef): string {
  return [ref.tool, ref.serverId, ref.workspaceId, ref.agentId].join("\n");
}

export class Connections {
  private plans = new Map<string, Plan>();
  /** Where each connection stood at the server's last answer, which no answer leaves as it is (handshake.ts), by key. */
  private known = new Map<string, Handshake>();
  /** Why the last code asked for a connection was not made, until one is, by key. */
  private codeRefused = new Map<string, string>();
  /**
   * Applies, one at a time whichever window asked: connections share files
   * (the skill, the default login, the command's link), so each is checked
   * against the files as the one before left them.
   */
  private applying: Promise<unknown> = Promise.resolve();
  private ledgerFile: string;

  constructor(private parts: ConnectionsParts) {
    this.ledgerFile = join(parts.dataDir, "connections.json");
  }

  /** Where the backups of the files Connect changes go, one folder per Apply. */
  get backupsDir(): string {
    return join(this.parts.dataDir, "backups");
  }

  /**
   * The harnesses, where each works, and where the quadit command stands,
   * as seen from the workspace `at` (the one Connect agents is for; null:
   * none shown): a tool's connection there, and those elsewhere.
   */
  async state(at: { serverId: string; workspaceId: string } | null = null): Promise<ConnectView> {
    const { home, cli } = this.parts;
    const look = await cli.look();
    const binary = look.found?.path ?? cli.bundled;
    const defaultConfig = binary ? await cli.defaultConfig(binary).catch(() => null) : null;
    const ledger = this.ledger();
    const skill = Object.keys(ledger.harnesses).length > 0 ? await this.currentSkill() : null;
    // The folders tied to each workspace are said, not needed: an index that cannot be read shows none.
    const index = defaultConfig ? safeIndex(dirname(defaultConfig)) : EMPTY_INDEX;
    const install = look.found || !cli.bundled ? null : look.install;
    return {
      at,
      harnesses: HARNESSES.map((harness) => {
        const tool = ledger.harnesses[harness.id];
        const views = (tool?.connections ?? []).map((c) => this.connectionView(harness, c, index));
        const here = at
          ? views.find((v) => v.ref.serverId === at.serverId && v.ref.workspaceId === at.workspaceId)
          : undefined;
        return {
          id: harness.id,
          name: harness.name,
          initials: harness.initials,
          installed: this.installed(harness, look.path),
          unavailable: this.unavailable(harness),
          mcp: !!harness.mcp,
          cliIdentity: harness.env ? "own" : "default",
          listenVerified: harness.listenVerified,
          chatListens: harness.chatListens,
          allows: !!harness.allowCli,
          skillChangedByHand: !!tool && skill !== null && this.skillState(ledger, harness, skill) === "by hand",
          connected: here ?? null,
          elsewhere: views.filter((v) => v !== here),
        };
      }),
      cli: {
        found: look.found?.path ?? null,
        version: look.found?.version ?? "",
        linkInto: install?.way === "link" ? homely(home, install.folder) : null,
        profile: install?.way === "link" && install.profile ? homely(home, install.profile.path) : null,
        pathFolder: install?.way === "path" ? install.folder : null,
        manual: look.found || install ? null : manualInstall(cli.bundled, this.parts.platform),
      },
      defaultLogin: defaultConfig && binary ? await this.defaultLogins(binary, defaultConfig, index) : [],
      claudePlugin: claudePluginInstalled(home),
    };
  }

  /** The computer's default login, one for each workspace the index lists it in, else the one its file holds. */
  private async defaultLogins(
    binary: string,
    defaultConfig: string,
    index: LoginIndex,
  ): Promise<ConnectView["defaultLogin"]> {
    const listed = loginsOf(index, defaultConfig);
    if (listed.length > 0) return listed.map((l) => ({ server: l.server, agent: l.agent ? `@${l.agent}` : null }));
    if (!existsSync(defaultConfig)) return [];
    const agent = await this.parts.cli.whoIs(binary, defaultConfig).then(
      (who) => `@${who.handle}`,
      () => null,
    );
    return [{ server: savedServer(defaultConfig), agent }];
  }

  private connectionView(harness: Harness, c: Connection, index: LoginIndex): ConnectionView {
    return {
      ref: refOf(harness.id, c),
      methods: c.methods,
      server: this.parts.server(c.serverId)?.name ?? "a removed server",
      workspace: this.workspaceName(c.serverId, c.workspaceId) || c.workspaceName,
      agent: `@${c.agent.handle}`,
      folders: index.folders
        .filter((tie) => tie.workspaceId === c.workspaceId)
        .map((tie) => ({ path: tie.folder, shown: homely(this.parts.home, tie.folder), project: tie.project })),
    };
  }

  /**
   * What the app does for the tools Connect set up at every start of the
   * app, in the background too, saying nothing: a ledger from before
   * several workspaces is brought to this one (upgradeLedger), their skills
   * follow the quadit they run (refreshSkills), and a tool connected by a
   * version from before is given, once, what lets it use Quadit without
   * asking (allowConnected). Gives what was done.
   */
  refresh(): Promise<{ skills: { updated: string[]; changedByHand: string[] }; allowed: string[] }> {
    return this.inTurn(async () => {
      await this.upgradeLedger();
      return { skills: await this.refreshSkills(), allowed: await this.allowConnected() };
    });
  }

  /**
   * Brings a ledger from before several workspaces (one connection per tool)
   * to this one, saved. A tool that worked as the computer's default login
   * the app had not made (one of the person's own) was recorded for the
   * workspace it was connected from, which says nothing of the login: what
   * its own server says of it (`quadit me`) is what it is, a workspace of a
   * server the app has. Not answered, it is kept as recorded, and never
   * asked about (no member).
   */
  private async upgradeLedger() {
    if (!this.ledgerIsOld()) return;
    const ledger = this.ledger();
    const binary = (await this.parts.cli.look()).found?.path ?? this.parts.cli.bundled;
    const defaultConfig = binary ? await this.parts.cli.defaultConfig(binary).catch(() => null) : null;
    for (const tool of Object.values(ledger.harnesses)) {
      for (const c of tool.connections) {
        if (c.token || !c.methods.includes("cli") || !binary || !defaultConfig) continue;
        const who = await this.parts.cli.whoIs(binary, defaultConfig).catch(() => null);
        const url = savedServer(defaultConfig);
        const serverId = url ? this.parts.serverAt(url) : null;
        if (!who?.workspace || !serverId) continue;
        c.serverId = serverId;
        c.workspaceId = who.workspace.id;
        c.workspaceName = who.workspace.name;
        c.agent = { id: who.id, handle: who.handle };
        c.member = who.agent ? { id: who.id, handle: who.handle } : null;
        c.code = null;
      }
    }
    this.saveLedger(ledger);
  }

  /**
   * Gives each tool in the ledger not yet given them (a connection from a
   * version before) what lets it use Quadit without asking, through the
   * same plan, backup and ledger as Connect, so Disconnect takes it back;
   * what is there already is the person's and left alone. Marked once done,
   * it is never written again for that tool, even after the person takes
   * it away, or kept part of it (a setting of theirs in the way). A tool
   * whose files cannot all be written gets back what was, and is tried
   * again at the next start. Saved tool by tool. Gives the tools written to.
   */
  private async allowConnected(): Promise<string[]> {
    const ledger = this.ledger();
    const owed = Object.entries(ledger.harnesses).filter(([, tool]) => !tool.allowed);
    if (owed.length === 0) return [];
    const { home } = this.parts;
    const look = await this.parts.cli.look();
    const done: string[] = [];
    for (const [id, tool] of owed) {
      const harness = HARNESSES.find((h) => h.id === id);
      if (!harness) continue;
      const groups: AllowGroup[] = [];
      if (tool.connections.some((c) => c.methods.includes("cli")))
        for (const group of harness.allowCli ?? [])
          groups.push({
            changes: group.changes(home, look.found?.path ?? null, this.parts.platform),
            said: group.said,
          });
      const viaMcp = tool.connections.find((c) => c.methods.includes("mcp"));
      const origin = viaMcp && this.parts.server(viaMcp.serverId)?.origin;
      const mcpAllow = harness.mcp?.allow;
      if (mcpAllow && origin) groups.push({ changes: mcpAllow.changes(home, `${origin}/mcp`), said: mcpAllow.said });
      const others = this.recordsByTarget({
        harnesses: Object.fromEntries(Object.entries(ledger.harnesses).filter(([other]) => other !== id)),
      });
      const make = allowable(groups, []);
      const own = make.filter((change) => !others.has(targetOf(change)));
      const { edits, applied } = planChanges(own);
      const records = hashed(applied, edits, backUp(edits, this.backupDir(id)));
      writeOrTakeBack(edits, records);
      tool.edits.push(...records, ...make.flatMap((change) => others.get(targetOf(change)) ?? []));
      if (edits.length > 0) done.push(id);
      // Once, whatever the person had in the way: never again after.
      tool.allowed = true;
      this.saveLedger(ledger);
    }
    return done;
  }

  /**
   * Brings the skill of every tool Connect set up up to date with the skill
   * Connect writes now (currentSkill). A skill file that still says what Connect wrote is rewritten,
   * backed up first, and the ledger records the new text, so Disconnect
   * takes back exactly what is there; one changed by hand since is left as
   * it is (its tool's card offers updateSkill); a skill the app did not
   * install is never touched. Gives the files rewritten, and those left for
   * being changed by hand.
   */
  private async refreshSkills(): Promise<{ updated: string[]; changedByHand: string[] }> {
    const done = { updated: [] as string[], changedByHand: [] as string[] };
    const ledger = this.ledger();
    if (Object.keys(ledger.harnesses).length === 0) return done;
    const skill = await this.currentSkill();
    if (skill === null) return done;
    const seen = new Set<string>();
    for (const id of Object.keys(ledger.harnesses)) {
      const harness = HARNESSES.find((h) => h.id === id);
      const path = harness && this.skillPath(ledger, harness);
      if (!harness || !path || seen.has(path)) continue;
      seen.add(path);
      const state = this.skillState(ledger, harness, skill);
      if (state === "by hand") done.changedByHand.push(path);
      else if (state === "outdated" && this.rewriteSkill(ledger, path, skill)) done.updated.push(path);
    }
    if (done.updated.length > 0) this.saveLedger(ledger);
    return done;
  }

  /** Writes the skill the tools' quadit carries now over a tool's skill the person changed by hand (its card's "Update it"). */
  updateSkill(harnessId: string): Promise<{ ok: true } | Refused> {
    return this.inTurn(async () => {
      const ledger = this.ledger();
      const harness = HARNESSES.find((h) => h.id === harnessId);
      const path = harness && ledger.harnesses[harnessId] ? this.skillPath(ledger, harness) : null;
      if (!harness || !path) return { ok: false, error: `${harness?.name ?? "It"} is not connected.` };
      const skill = await this.currentSkill();
      if (skill === null) return { ok: false, error: "The quadit command did not give its skill: try again." };
      if (readText(path) !== skill && !this.rewriteSkill(ledger, path, skill))
        return { ok: false, error: `${path} cannot be written.` };
      this.saveLedger(ledger);
      return { ok: true };
    });
  }

  /**
   * The skill Connect writes: the one the app's own quadit carries, else the
   * one of the quadit on the login shell's PATH; null when none says.
   */
  private async currentSkill(): Promise<string | null> {
    const own = this.parts.ownQuadit();
    const skill = own ? await this.skillOf(own) : null;
    if (skill !== null) return skill;
    const binary = await this.binary();
    return binary ? this.skillOf(binary) : null;
  }

  /**
   * Before Quadit runs a tool's agent for a project: its Quadit skill has
   * the section for runs Quadit starts (RUN_SECTION). One the app wrote and
   * nobody changed since is brought up to date first; one changed by hand,
   * or not the app's, is left as it is, and the run is refused, saying so.
   */
  skillForRuns(harnessId: string): Promise<{ ok: true } | Refused> {
    return this.inTurn(async () => {
      const harness = HARNESSES.find((h) => h.id === harnessId);
      if (!harness) return { ok: false, error: "There is no such tool." };
      const installed = realPath(join(this.parts.home, harness.skills, "quadit", "SKILL.md"));
      if (readText(installed)?.includes(RUN_SECTION)) return { ok: true };
      const ledger = this.ledger();
      const path = this.skillPath(ledger, harness);
      const skill = await this.currentSkill();
      const state = path && skill !== null ? this.skillState(ledger, harness, skill) : null;
      if (state === "by hand")
        return {
          ok: false,
          error: `The Quadit skill for ${harness.name} was changed by hand and has no section for runs Quadit starts: update it first.`,
        };
      if (path && state === "outdated" && skill?.includes(RUN_SECTION) && this.rewriteSkill(ledger, path, skill)) {
        this.saveLedger(ledger);
        return { ok: true };
      }
      return {
        ok: false,
        error: `The Quadit skill for ${harness.name} has no section for runs Quadit starts: update the Quadit app, or connect ${harness.name} again.`,
      };
    });
  }

  private skillOf(binary: string): Promise<string | null> {
    return this.parts.cli.skill(binary).catch(() => null);
  }

  /** Where `harness` reads the Quadit skill, when Connect wrote it there (the ledger has it); null otherwise. */
  private skillPath(ledger: Ledger, harness: Harness): string | null {
    const path = realPath(join(this.parts.home, harness.skills, "quadit", "SKILL.md"));
    const wrote = ledger.harnesses[harness.id]?.edits.some((record) => record.kind === "file" && record.path === path);
    return wrote ? path : null;
  }

  /**
   * How `harness`'s skill file stands against `skill`, the text its quadit
   * carries now: up to date (or gone, or not the app's), still what Connect
   * wrote and so outdated, or changed by hand since.
   */
  private skillState(ledger: Ledger, harness: Harness, skill: string): "current" | "outdated" | "by hand" {
    const path = this.skillPath(ledger, harness);
    const record = ledger.harnesses[harness.id]?.edits.find((r) => r.kind === "file" && r.path === path);
    const text = path && readText(path);
    if (!path || record?.kind !== "file" || !text || text === skill) return "current";
    return sha256(text) === record.sha256 ? "outdated" : "by hand";
  }

  /**
   * Writes `skill` at `path`, backed up first, and records its text in every
   * tool that shares the file (the original's backup stays, for
   * Disconnect); false when it cannot be written.
   */
  private rewriteSkill(ledger: Ledger, path: string, skill: string): boolean {
    try {
      const { edits } = planChanges([{ kind: "file", path, content: skill }]);
      backUp(edits, this.backupDir("skill"));
      writeEdits(edits);
    } catch (err) {
      if (err instanceof EditRefused) return false;
      throw err;
    }
    for (const tool of Object.values(ledger.harnesses)) {
      for (const record of tool.edits) {
        if (record.kind === "file" && record.path === path) record.sha256 = sha256(skill);
      }
    }
    return true;
  }

  /** Whether `harness` is on this computer: its trace in the home folder, or its command on `path`. */
  private installed(harness: Harness, path: string[]): boolean {
    return (
      existsSync(join(this.parts.home, harness.trace)) ||
      findCommand(harness.command, path, this.parts.platform) !== null
    );
  }

  /** Why `harness` cannot be connected on this computer, in a sentence; null when it can. */
  private unavailable(harness: Harness): string | null {
    return this.parts.platform === "win32" ? (harness.notOnWindows ?? null) : null;
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

  private async makeConnectPlan(choice: ConnectChoice): Promise<ConnectPlan> {
    const { home, cli, platform } = this.parts;
    const harness = HARNESSES.find((h) => h.id === choice.harness);
    if (!harness) throw new EditRefused("There is no such harness.");
    const unavailable = this.unavailable(harness);
    if (unavailable) throw new EditRefused(unavailable);
    const ledger = this.ledger();
    const tool = ledger.harnesses[harness.id];
    if (tool?.connections.some((c) => c.serverId === choice.serverId && c.workspaceId === choice.workspaceId))
      throw new EditRefused(`${harness.name} is connected here already.`);
    const methods = [...new Set(choice.methods)].filter((m) => m === "cli" || (m === "mcp" && harness.mcp));
    if (methods.length === 0) throw new EditRefused("Pick how to connect it.");
    const summary = this.parts
      .summaries()
      .find(
        (s) => s.serverId === choice.serverId && s.summary.workspace.id === choice.workspaceId && s.listening,
      )?.summary;
    const origin = this.parts.server(choice.serverId)?.origin;
    if (!summary || !origin) throw new EditRefused("Open that workspace in its server's window first.");
    if (tool) return this.planAdded(harness, tool, { ...choice, methods }, summary, origin);
    // What another tool did already is shared with it, not done again.
    const others = this.recordsByTarget(ledger);
    const changes: Change[] = [];
    const warnings: string[] = [];
    const allow: AllowGroup[] = [];
    let login: ConnectPlan["login"] = null;
    let base: string | null = null;
    let worksAs: ConnectPlan["worksAs"] = null;
    let sharedToken: Connection["token"] = null;
    if (methods.includes("cli")) {
      const look = await cli.look();
      const binary = look.found?.path ?? cli.bundled;
      const install = look.found || !cli.bundled ? null : look.install;
      if (!binary || (!look.found && !install)) {
        throw new EditRefused(
          `The quadit command is not on your PATH. Put it there, then try again: ${manualInstall(cli.bundled, platform)}`,
        );
      }
      // The command on PATH may be the link another connection made: this one needs it too, with the folder and
      // the profile line that came with it. On Windows, its folder another connection added to the PATH.
      const linked = look.found && others.get(targetOf({ kind: "link", path: look.found.path, target: "" }));
      const pathAdded =
        look.found &&
        platform === "win32" &&
        others.get(targetOf({ kind: "path", path: USER_PATH, folder: win32.dirname(look.found.path) }));
      if (pathAdded && pathAdded.kind === "path") {
        changes.push({ kind: "path", path: USER_PATH, folder: pathAdded.folder });
      } else if (linked && linked.kind === "link") {
        changes.push({ kind: "link", path: linked.path, target: linked.target });
        for (const record of others.values()) {
          if (record.kind === "folder" && record.path === dirname(linked.path)) changes.push(record);
          // The profile line that puts the folder on the PATH; never another tool's own settings (its command rules).
          if (record.kind === "line" && !HARNESSES.some((h) => h.rules && record.path === join(home, h.rules.file)))
            changes.push({ kind: "line", path: record.path, line: record.line });
        }
      } else if (install?.way === "path") {
        changes.push({ kind: "path", path: USER_PATH, folder: install.folder });
      } else if (install?.way === "link" && cli.bundled) {
        const { folder, profile } = install;
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
        content: (await this.currentSkill()) ?? (await cli.skill(binary).catch(tooOld)),
      });
      // The command as an agent may call it by its path: the one on the PATH, or the app's copy put there now.
      const command =
        look.found?.path ?? (install?.way === "path" ? cli.bundled : install ? join(install.folder, "quadit") : null);
      for (const group of harness.allowCli ?? [])
        allow.push({ changes: group.changes(home, command, platform), said: group.said });
      if (harness.selfRunSaid) warnings.push(harness.selfRunSaid);
      const defaultConfig = await cli.defaultConfig(binary).catch(tooOld);
      const shown = `${JSON.stringify({ url: origin, token: MASKED_TOKEN }, null, 2)}\n`;
      if (harness.env) {
        base = join(dirname(defaultConfig), `${harness.id}.json`);
        changes.push({ kind: "written-by", path: base, shown }, ...harness.env(home, base));
        login = { binary };
      } else {
        base = defaultConfig;
        // A default login there already is who the tool works as in its workspace: here, when that is this one.
        const there = await this.loginIn(binary, defaultConfig, choice.workspaceId, origin).catch((err: Error) => {
          throw new EditRefused(
            `The default login (${defaultConfig}) did not say who it is, so Connect cannot tell whom ${harness.name} would work as: ${err.message}`,
          );
        });
        const own = harness.mcp ? " Connect it by MCP to give it an agent of its own." : "";
        if (there) {
          worksAs = there;
          const made = this.madeLogin(ledger, there.login, defaultConfig);
          warnings.push(
            `${harness.name} has no setting the app can use to give quadit its own login, so there quadit works as this ` +
              `computer's default login: @${there.handle} in ${summary.workspace.name}. ` +
              (made ? "Connect made that login for another harness." : "Connect leaves that login as it is.") +
              own,
          );
          if (made) {
            sharedToken = made.token;
            if (there.login === realPath(defaultConfig))
              changes.push({ kind: "written-by", path: defaultConfig, shown });
          }
        } else if (existsSync(defaultConfig) || loginsOf(safeIndex(dirname(defaultConfig)), defaultConfig).length > 0) {
          // The default login works in another workspace: one for this one goes beside it.
          await this.refuseOld(binary, harness);
          login = { binary };
          changes.push({ kind: "written-by", path: addedLogin(defaultConfig, summary.workspace.slug), shown });
          warnings.push(
            `${harness.name} has no setting the app can use to give quadit its own login, so there quadit works as this ` +
              `computer's default login, which works in another workspace already: a login for ${summary.workspace.name} ` +
              `is added beside it, for the agent chosen.${own}`,
          );
        } else {
          warnings.push(
            `${harness.name} has no setting the app can use to give quadit its own login, so there quadit works as ` +
              `this computer's default login (${defaultConfig}), made now for the agent chosen.${own}`,
          );
          changes.push({ kind: "written-by", path: defaultConfig, shown });
          login = { binary };
        }
      }
    }
    if (methods.includes("mcp") && harness.mcp) {
      changes.push(...harness.mcp.changes(home, `${origin}/mcp`));
      const { allow: mcpAllow } = harness.mcp;
      if (mcpAllow) allow.push({ changes: mcpAllow.changes(home, `${origin}/mcp`), said: mcpAllow.said });
    }
    changes.push(...allowable(allow, warnings));
    if (harness.id === "claude" && claudePluginInstalled(home)) {
      warnings.push(
        "The Quadit plugin for Claude Code is installed. Its MCP entry needs QUADIT_URL and QUADIT_TOKEN in the environment, " +
          "which Connect does not set: turn the plugin off in Claude Code (/plugin) when you connect here.",
      );
    }

    // An agent is chosen only where the choice holds: not for the quadit command alone on a default login already there.
    const agent = !worksAs || methods.includes("mcp") ? this.chosenAgent(choice, summary) : null;
    const own = changes.filter((change) => !others.has(targetOf(change)));
    const shared = changes.flatMap((change) => others.get(targetOf(change)) ?? []);
    const { edits, applied } = planChanges(own);
    return this.keep({
      kind: "connect",
      id: randomBytes(9).toString("base64url"),
      harness,
      choice: { ...choice, methods },
      origin,
      workspaceName: summary.workspace.name,
      toolThere: false,
      agent,
      worksAs,
      edits,
      applied,
      shared,
      sharedToken,
      login,
      base,
      backupDir: this.backupDir(harness.id),
      warnings,
    });
  }

  /**
   * Connect here as well: the plan for a tool that works in another
   * workspace already. Its settings, skill and permissions stay as they
   * are; with the quadit command alone (its MCP entry stays with the first
   * workspace), it gets a login for this workspace beside its first, made by
   * a quadit that keeps one per workspace, unless its base login has one
   * here already, which it then works as.
   */
  private async planAdded(
    harness: Harness,
    tool: ToolRecord,
    choice: ConnectChoice,
    summary: DesktopSummary,
    origin: string,
  ): Promise<ConnectPlan> {
    const elsewhere = tool.connections.map((c) => this.workspaceName(c.serverId, c.workspaceId) || c.workspaceName);
    if (choice.methods.includes("mcp"))
      throw new EditRefused(
        `${harness.name} reaches Quadit's MCP server in ${elsewhere.join(" and ")} only: connect it here with the quadit command.`,
      );
    if (!tool.connections.some((c) => c.methods.includes("cli")))
      throw new EditRefused(
        `${harness.name} is connected by MCP alone in ${elsewhere.join(" and ")}: disconnect it there, and connect it again with the quadit command.`,
      );
    const binary = await this.binary();
    if (!binary) throw new EditRefused(`The quadit command is not on your PATH: put it there, then try again.`);
    await this.refuseOld(binary, harness);
    const base = await this.baseOf(tool, binary);
    if (!base) throw new EditRefused("The quadit command did not say where its logins are: update it.");
    const there = await this.loginIn(binary, base, choice.workspaceId, origin).catch((err: Error) => {
      throw new EditRefused(`${base} did not say who it is: ${err.message}`);
    });
    const ledger = this.ledger();
    const warnings = [
      `${harness.name} keeps working in ${elsewhere.join(" and ")}, and its settings stay as they are.`,
    ];
    let changes: Change[] = [];
    let sharedToken: Connection["token"] = null;
    if (there) {
      sharedToken = this.madeLogin(ledger, there.login, base)?.token ?? null;
      warnings.push(`There quadit works as @${there.handle}, a login of ${summary.workspace.name} there already.`);
    } else {
      const shown = `${JSON.stringify({ url: origin, token: MASKED_TOKEN }, null, 2)}\n`;
      changes = [{ kind: "written-by", path: addedLogin(base, summary.workspace.slug), shown }];
    }
    const { edits, applied } = planChanges(changes);
    return this.keep({
      kind: "connect",
      id: randomBytes(9).toString("base64url"),
      harness,
      choice,
      origin,
      workspaceName: summary.workspace.name,
      toolThere: true,
      agent: there ? null : this.chosenAgent(choice, summary),
      worksAs: there,
      edits,
      applied,
      shared: [],
      sharedToken,
      login: there ? null : { binary },
      base,
      backupDir: this.backupDir(harness.id),
      warnings,
    });
  }

  /** The agent `choice` picks among those of the workspace `summary` describes, or null for one to make; refused otherwise. */
  private chosenAgent(choice: ConnectChoice, summary: DesktopSummary): ConnectPlan["agent"] {
    if (!choice.agent) throw new EditRefused("Pick an agent you may connect as.");
    if ("create" in choice.agent) {
      if (!summary.me.canCreateAgents) throw new EditRefused("You may not make agents in this workspace.");
      if (!choice.agent.create.name.trim() || !choice.agent.create.handle.trim())
        throw new EditRefused("Give the new agent a name and a handle.");
      return null;
    }
    const id = choice.agent.id;
    const agent = summary.agents.find((a) => a.id === id && a.usable);
    if (!agent) throw new EditRefused("Pick an agent you may connect as.");
    return agent;
  }

  /** A second workspace needs a quadit that keeps a login per workspace: an older one would log it in over the first. */
  private async refuseOld(binary: string, harness: Harness) {
    if (!(await this.parts.cli.knowsWorkspaces(binary)))
      throw new EditRefused(
        `${binary} is older than this app and cannot give ${harness.name} a login for a second workspace: update it.`,
      );
  }

  /**
   * The login of the base login `base` in the workspace `workspaceId` of the
   * server at `origin`, and whom it is, when it has one: the index's, or,
   * where the index lists none of `base`, the base file itself as its own
   * server says (`quadit me`, which throws when it cannot say). Null otherwise.
   */
  private async loginIn(
    binary: string,
    base: string,
    workspaceId: string,
    origin: string,
  ): Promise<{ id: string; handle: string; login: string } | null> {
    const listed = loginsOf(readIndex(dirname(base)), base);
    if (listed.length > 0) {
      const found = listed.find((l) => l.workspaceId === workspaceId && sameServer(l.server, origin));
      return found ? { id: found.agentId, handle: found.agent, login: found.login } : null;
    }
    if (!existsSync(base)) return null;
    const who = await this.parts.cli.whoIs(binary, base);
    return who.workspace?.id === workspaceId && sameServer(savedServer(base) ?? "", origin)
      ? { id: who.id, handle: who.handle, login: realPath(base) }
      : null;
  }

  /** The connection of any tool whose login is the file `login` the app made (its token), if any. */
  private madeLogin(ledger: Ledger, login: string, defaultConfig: string): Connection | undefined {
    for (const tool of Object.values(ledger.harnesses))
      for (const c of tool.connections)
        if (c.token && loginFileOf(tool, c, defaultConfig) === realPath(login)) return c;
    return undefined;
  }

  /** Keeps `plan` as the one outstanding: a new one replaces any other. */
  private keep<P extends Plan>(plan: P): P {
    this.plans.clear();
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Drops the outstanding plan (its page cancelled it or closed). */
  dropPlans() {
    this.plans.clear();
  }

  /**
   * Carries out a connect plan the person saw; it is good for one Apply, and
   * waits for any other Apply under way. Gives what to do next, the
   * connection made (its ref, and its workspace's name), whether it is the
   * tool's second workspace or more (`added`), and the workspace's agent the
   * tool works as: the one chosen (or made), or, for a tool that works as a
   * login there already, that login's agent when it is an agent of this
   * workspace (null otherwise).
   */
  applyConnect(planId: string): Promise<
    | {
        ok: true;
        hint: string;
        agent: { id: string; handle: string } | null;
        connection: { ref: ConnectionRef; workspace: string };
        added: boolean;
      }
    | Refused
  > {
    // Taken at once: a second Apply of the same plan, or a new plan meanwhile, finds it gone.
    const plan = this.plans.get(planId);
    this.plans.delete(planId);
    return this.inTurn(async () => {
      if (plan?.kind !== "connect")
        return { ok: false, error: "That plan is gone: review the changes again.", stale: true };
      const { choice, harness } = plan;
      const before = this.ledger().harnesses[harness.id];
      if (before?.connections.some((c) => c.serverId === choice.serverId && c.workspaceId === choice.workspaceId))
        return { ok: false, error: `${harness.name} is connected here already.`, stale: true };
      // Connected or disconnected elsewhere meanwhile: the plan was made for the tool as it was.
      if (!!before !== plan.toolThere)
        return { ok: false, error: "That plan is gone: review the changes again.", stale: true };
      const changed = changedSince(plan.edits);
      if (changed)
        return {
          ok: false,
          error: `${changed.path} changed since you reviewed the plan: review it again.`,
          stale: true,
        };
      const ask = (request: DesktopRequest) => this.parts.ask(choice.serverId, choice.workspaceId, request);

      // An agent is made only where the choice holds: a tool on a login there already works as that login.
      const choiceHolds = !plan.worksAs || choice.methods.includes("mcp");
      let agent = plan.agent;
      if (choiceHolds && !agent && choice.agent && "create" in choice.agent) {
        const made = await ask({ kind: "agent", create: choice.agent.create });
        if (!made.ok || !made.agent) return { ok: false, error: made.ok ? "The agent was not made." : made.message };
        agent = made.agent;
      }
      const worksAs = plan.worksAs ?? agent;
      if (!worksAs) return { ok: false, error: "Pick an agent you may connect as." };

      const backups = backUp(plan.edits, plan.backupDir);
      let token = plan.sharedToken;
      // The file the connection's login is in: the one there already, else where the quadit command put the new one.
      let login = plan.worksAs?.login ?? null;
      if (plan.login && plan.base) {
        const label = `${harness.name} on ${this.parts.hostName}`;
        const issued = await ask({ kind: "agent-token", agent: worksAs.id, label });
        if (!issued.ok || !issued.token) return { ok: false, error: issued.ok ? "No token was made." : issued.message };
        const revoke = () => void ask({ kind: "revoke-token", token: issued.token?.id ?? "" });
        try {
          await this.parts.cli.login(
            plan.login.binary,
            plan.origin,
            issued.token.secret,
            plan.base,
            this.parts.appFor(choice.serverId),
          );
          login = this.landedLogin(plan.base, choice.workspaceId, plan.origin);
        } catch (err) {
          revoke();
          return { ok: false, error: (err as Error).message };
        }
        if (!login) {
          revoke();
          return {
            ok: false,
            error: `quadit login kept no login for ${plan.workspaceName} that the app can find: update quadit, and try again.`,
          };
        }
        token = { id: issued.token.id, label };
      }
      // What `quadit login` wrote is known now: the login is the app's, to take back, where it went into the file the
      // plan showed; one the quadit command put beside it (a second workspace's) is the command's (quadit logout).
      const base = plan.base && realPath(plan.base);
      const writtenBy = new Set(plan.edits.filter((edit) => edit.writtenBy).map((edit) => edit.path));
      const records = hashed(plan.applied, plan.edits, backups).filter(
        (record) =>
          !(record.kind === "file" && writtenBy.has(record.path) && (record.path !== login || login !== base)),
      );
      try {
        writeOrTakeBack(plan.edits, records);
      } catch (err) {
        if (plan.login && token) void ask({ kind: "revoke-token", token: token.id });
        return {
          ok: false,
          error: `Connect stopped midway, and took back what it had done: ${(err as Error).message}`,
        };
      }
      const link = plan.applied.find((record) => record.kind === "link");
      if (link) this.parts.cli.linked(link.path);

      // The agent of this workspace the tool works as can prove the connection from inside it, given a code.
      const member = choiceHolds ? agent && { id: agent.id, handle: agent.handle } : this.memberOf(plan, worksAs);
      const code =
        member && choice.methods.includes("cli")
          ? await this.makeCode(choice.serverId, choice.workspaceId, member.id, harness.name)
          : null;

      const ledger = this.ledger();
      const connection: Connection = {
        serverId: choice.serverId,
        workspaceId: choice.workspaceId,
        workspaceName: plan.workspaceName,
        methods: choice.methods,
        agent: { id: worksAs.id, handle: worksAs.handle },
        ...(login && login !== base ? { login } : {}),
        token,
        member,
        code: code?.ok ? code.code : null,
        at: Date.now(),
      };
      const tool = ledger.harnesses[harness.id];
      if (tool) tool.connections.push(connection);
      else
        ledger.harnesses[harness.id] = {
          edits: [...records, ...plan.shared],
          ...(base ? { base } : {}),
          allowed: true,
          connections: [connection],
        };
      this.saveLedger(ledger);
      const ref = refOf(harness.id, connection);
      const key = connectionKey(ref);
      this.known.delete(key);
      if (code && !code.ok) this.codeRefused.set(key, code.error);
      else this.codeRefused.delete(key);
      const hint = tool
        ? `${harness.name} works in ${plan.workspaceName} as @${worksAs.handle} too: choose the folders where it does, so it knows which workspace a chat there is for.`
        : connectedHint(harness, choice.methods, worksAs.handle, agent?.handle ?? worksAs.handle);
      // The login PATH changed (a folder of the person's own, the line that puts it there, or the PATH itself): open
      // terminals keep the old one.
      const newPath = plan.applied.some(
        (record) => record.kind === "line" || record.kind === "folder" || record.kind === "path",
      );
      this.parts.connected(key, code?.ok ? code.code.code : null);
      return {
        ok: true,
        hint: newPath ? `${hint} Terminals opened from now on find quadit; reopen any that are open now.` : hint,
        agent: member,
        connection: { ref, workspace: plan.workspaceName },
        added: !!tool,
      };
    });
  }

  /** The file of the base login `base` where `quadit login` just put the login of the workspace `workspaceId`; null when it is not to be found. */
  private landedLogin(base: string, workspaceId: string, origin: string): string | null {
    const listed = loginsOf(readIndex(dirname(base)), base);
    const found = listed.find((l) => l.workspaceId === workspaceId && sameServer(l.server, origin));
    if (found) return found.login;
    return listed.length === 0 && sameServer(savedServer(base) ?? "", origin) ? realPath(base) : null;
  }

  /** The login a plan works as there already, when it is an agent of the plan's workspace (its window lists it). Null otherwise. */
  private memberOf(plan: ConnectPlan, who: { id: string; handle: string }): { id: string; handle: string } | null {
    const summary = this.parts
      .summaries()
      .find((s) => s.serverId === plan.choice.serverId && s.summary.workspace.id === plan.choice.workspaceId)?.summary;
    return summary?.agents.some((a) => a.id === who.id) ? { id: who.id, handle: who.handle } : null;
  }

  /**
   * Where a connection stands with Quadit, asked of the page of its
   * workspace about the agent it works as there (handshake.ts); null when
   * it is not set up (taken back, or never made). One that works as a login
   * the app may not ask that workspace about is never asked about: where it
   * stands is not known here. A code given back, or gone, is let go.
   */
  async handshake(ref: ConnectionRef): Promise<Handshake | null> {
    const found = this.find(this.ledger(), ref);
    if (!found) return null;
    const { connection } = found;
    const key = connectionKey(ref);
    if (!connection.member) return { state: "unknown" };
    const code = connection.code;
    const answer = await this.parts.ask(connection.serverId, connection.workspaceId, {
      kind: "agent-state",
      agent: connection.member.id,
      ...(code ? { code: code.id } : {}),
    });
    if (code && answer.ok && (answer.codeUsed === true || answer.codeGone === true)) {
      await this.inTurn(async () => {
        const ledger = this.ledger();
        const now = this.find(ledger, ref)?.connection;
        if (now?.code?.id !== code.id) return;
        now.code = null;
        this.saveLedger(ledger);
      });
    }
    const now = handshakeOf({ methods: connection.methods, code }, answer, Date.now(), this.known.get(key));
    this.known.set(key, now);
    const refused = this.codeRefused.get(key);
    return now.state === "waiting" && now.code === null && refused ? { ...now, refused } : now;
  }

  /** Makes a new connect code for a connection (the one it had is gone or ran out, or it had none), replacing the old one. */
  newCode(ref: ConnectionRef): Promise<{ ok: true } | Refused> {
    return this.inTurn(async () => {
      const found = this.find(this.ledger(), ref);
      const harness = HARNESSES.find((h) => h.id === ref.tool);
      if (!found || !harness) return { ok: false, error: `${harness?.name ?? "It"} is not connected there.` };
      const { connection } = found;
      const key = connectionKey(ref);
      if (!connection.member)
        return {
          ok: false,
          error: `${harness.name} works there as a login that is not one of the workspace's agents: there is no code to make.`,
        };
      const made = await this.makeCode(connection.serverId, connection.workspaceId, connection.member.id, harness.name);
      if (!made.ok) {
        this.codeRefused.set(key, made.error);
        return made;
      }
      this.codeRefused.delete(key);
      // Read again: what was asked of the page took a while.
      const ledger = this.ledger();
      const now = this.find(ledger, ref)?.connection;
      if (!now) return { ok: false, error: `${harness.name} is not connected there.` };
      now.code = made.code;
      this.saveLedger(ledger);
      this.parts.connected(key, made.code.code);
      return { ok: true };
    });
  }

  /**
   * The connections through the quadit command, as the app runs their tool
   * (self-runs.ts): the connection (`key`), its tool, its own login file
   * (which says whether it is the app's own server's), what its run is given
   * (QUADIT_CONFIG, the tool's base login, as the tool's own settings give
   * it; and QUADIT_WORKSPACE, the workspace, which a tool with several
   * logins needs to give a code back: multi-workspace design, contract
   * changes 5), the workspace's name for the line, and whether the app ran it.
   */
  async selfRunTools(): Promise<
    {
      key: string;
      tool: string;
      login: string;
      config: string;
      workspace: string;
      workspaceName: string;
      ran: boolean;
    }[]
  > {
    const ledger = this.ledger();
    const binary = await this.binary();
    const defaultConfig = binary ? await this.parts.cli.defaultConfig(binary).catch(() => null) : null;
    return Object.entries(ledger.harnesses).flatMap(([id, tool]) => {
      const base = tool.base ?? defaultConfig;
      if (!base) return [];
      return tool.connections.flatMap((c) =>
        c.methods.includes("cli")
          ? [
              {
                key: connectionKey(refOf(id, c)),
                tool: id,
                login: c.login ?? base,
                config: base,
                workspace: c.workspaceId,
                workspaceName: this.workspaceName(c.serverId, c.workspaceId) || c.workspaceName,
                ran: c.ran === true,
              },
            ]
          : [],
      );
    });
  }

  /**
   * The agent Quadit can run a connected Claude Code or Codex as in the
   * connection `ref`, for a project of this computer (agent-runs-contract.md
   * §8.2): its login file there, which is an agent's the app made, and that
   * agent (its handle, and the server's address, the workspace and the agent
   * by id, which Quadit's runs are listed by); null for any other tool, one
   * connected there without the quadit command, or one without a login the
   * app made.
   */
  runAs(ref: ConnectionRef): {
    login: string;
    agent: string;
    program: RunProgram;
    identity: { server: string; workspace: string; agent: string };
  } | null {
    const found = this.find(this.ledger(), ref);
    const harness = HARNESSES.find((h) => h.id === ref.tool);
    if (!found || !harness?.env || (harness.id !== "claude" && harness.id !== "codex")) return null;
    const { tool, connection } = found;
    const login = connection.login ?? tool.base;
    const origin = this.parts.server(connection.serverId)?.origin;
    if (!connection.token || !login || !origin || !connection.methods.includes("cli")) return null;
    return {
      login,
      agent: `@${connection.agent.handle}`,
      program: harness.id,
      identity: { server: origin, workspace: connection.workspaceId, agent: connection.agent.id },
    };
  }

  /**
   * The tools Connect set up that work as an agent of the workspace
   * `workspaceId` of the server `serverId` (never another's): the tool, the
   * agent's user id, the server's address, and the login
   * file Quadit runs it with (runAs), null when Quadit cannot run it.
   */
  agentsOf(
    serverId: string,
    workspaceId: string,
  ): { tool: string; name: string; agent: string; origin: string; login: string | null }[] {
    return Object.entries(this.ledger().harnesses).flatMap(([id, tool]) => {
      const harness = HARNESSES.find((h) => h.id === id);
      if (!harness) return [];
      return tool.connections.flatMap((c) => {
        if (!c.member || c.serverId !== serverId || c.workspaceId !== workspaceId) return [];
        const origin = this.parts.server(serverId)?.origin ?? "";
        return [
          { tool: id, name: harness.name, agent: c.member.id, origin, login: this.runAs(refOf(id, c))?.login ?? null },
        ];
      });
    });
  }

  /** The connect codes still open, of the connections waiting to be proven, by key. */
  waitingCodes(): { key: string; code: string }[] {
    return Object.entries(this.ledger().harnesses).flatMap(([id, tool]) =>
      tool.connections.flatMap((c) =>
        c.code && Date.now() - c.code.at < CODE_LIFE_MS
          ? [{ key: connectionKey(refOf(id, c)), code: c.code.code }]
          : [],
      ),
    );
  }

  /** The connection the key `key` names (connectionKey), when the ledger has it. */
  connectionOf(key: string): ConnectionRef | null {
    for (const [id, tool] of Object.entries(this.ledger().harnesses))
      for (const c of tool.connections) if (connectionKey(refOf(id, c)) === key) return refOf(id, c);
    return null;
  }

  /** Marks a connection whose tool the app ran and saw give its connect code back, by key. */
  markRan(key: string) {
    const ledger = this.ledger();
    for (const [id, tool] of Object.entries(ledger.harnesses))
      for (const c of tool.connections)
        if (connectionKey(refOf(id, c)) === key) {
          c.ran = true;
          this.saveLedger(ledger);
          return;
        }
  }

  /**
   * Ties the folder `folder` to the workspace of the connection `ref`
   * (`quadit use`, with the checks Run by Quadit's folders have): there,
   * every tool that works in that workspace works in it.
   */
  tie(ref: ConnectionRef, folder: string): Promise<{ ok: true } | Refused> {
    return this.inTurn(async () => {
      const found = this.find(this.ledger(), ref);
      const binary = await this.binary();
      const base = found && binary ? await this.baseOf(found.tool, binary) : null;
      if (!found || !binary || !base) return { ok: false, error: "It is not connected there." };
      return this.parts.cli.tie(binary, base, ref.workspaceId, folder).then(
        () => ({ ok: true as const }),
        (err: Error) => ({ ok: false as const, error: err.message }),
      );
    });
  }

  /** Unties the folder `folder` from the workspace of the connection `ref` (`quadit use --clear`). */
  untie(ref: ConnectionRef, folder: string): Promise<{ ok: true } | Refused> {
    return this.inTurn(async () => {
      const found = this.find(this.ledger(), ref);
      const binary = await this.binary();
      const base = found && binary ? await this.baseOf(found.tool, binary) : null;
      if (!found || !binary || !base) return { ok: false, error: "It is not connected there." };
      const tied = safeIndex(dirname(base)).folders.some(
        (t) => t.folder === folder && t.workspaceId === ref.workspaceId,
      );
      if (!tied) return { ok: true };
      return this.parts.cli.untie(binary, base, folder).then(
        () => ({ ok: true as const }),
        (err: Error) => ({ ok: false as const, error: err.message }),
      );
    });
  }

  /**
   * Asks the workspace's page for a connect code for `agent` (a member id)
   * in the tool named `tool`. Only a code is taken (isConnectCode): the
   * person pastes its line into their agent.
   */
  private async makeCode(
    serverId: string,
    workspaceId: string,
    agent: string,
    tool: string,
  ): Promise<{ ok: true; code: OpenCode } | Refused> {
    const made = await this.parts.ask(serverId, workspaceId, { kind: "connect-code", agent, tool });
    if (!made.ok) return { ok: false, error: made.message };
    if (!made.id || made.code === undefined)
      return { ok: false, error: "Your workspace made no code: update Quadit there." };
    if (!isConnectCode(made.code))
      return { ok: false, error: "Your workspace gave a code that is not one: try again." };
    return { ok: true, code: { id: made.id, code: made.code, at: Date.now() } };
  }

  /**
   * Plans taking back one connection: its runs, its token and its login,
   * when the app made that login for it; with the tool's last, what was
   * changed for the tool, where its files still say what was written. The
   * folders tied to its workspace stay: other tools may work there.
   */
  async planDisconnect(ref: ConnectionRef): Promise<Planned> {
    const harness = HARNESSES.find((h) => h.id === ref.tool);
    const ledger = this.ledger();
    const found = this.find(ledger, ref);
    if (!harness || !found) return { ok: false, error: "It is not connected." };
    const { tool, connection } = found;
    try {
      const binary = await this.binary();
      const base = binary ? await this.baseOf(tool, binary) : (tool.base ?? null);
      const index = base ? readIndex(dirname(base)) : EMPTY_INDEX;
      // Only a login the app made for this connection (its token) is the app's to take away: never a login a tool
      // merely works as (the computer's default one, the person's), and none for one by MCP alone.
      const login = connection.methods.includes("cli") && connection.token ? (connection.login ?? base) : null;
      const last = tool.connections.length === 1;
      // A login another connection uses too (a tool that shares the computer's default login) stays, with its token.
      const shared =
        login !== null &&
        Object.entries(ledger.harnesses).some(([id, other]) =>
          other.connections.some(
            (c) =>
              c !== connection &&
              (id !== ref.tool || c.workspaceId !== ref.workspaceId) &&
              loginFileOf(other, c, base ?? "") === login,
          ),
        );
      const listed = login !== null && index.connections.some((l) => l.login === login);
      if (!last && !listed && !shared)
        throw new EditRefused(
          `The quadit command's index does not list ${harness.name}'s login in ${connection.workspaceName || "that workspace"}, so the app cannot tell which file to take away.`,
        );
      const others = this.targets(ledger, ref.tool);
      let records = last ? tool.edits.filter((record) => !others.has(targetOf(record))) : [];
      // A login the index lists is the quadit command's to take away (quadit logout), whatever the ledger recorded.
      if (listed) records = records.filter((record) => record.path !== login);
      const { edits, notes } = planReverts(records);
      const logout = listed && !shared && binary && base ? { binary, base } : null;
      if (logout && login) {
        const before = readText(login);
        if (before !== null)
          edits.push({ path: login, kind: "written-by", link: false, before, after: null, writtenBy: true });
      }
      const revoke = connection.token && !shared ? connection.token : null;
      const workspace = this.workspaceName(connection.serverId, connection.workspaceId) || connection.workspaceName;
      const elsewhere = tool.connections
        .filter((c) => c !== connection)
        .map((c) => this.workspaceName(c.serverId, c.workspaceId) || c.workspaceName);
      const plan = this.keep<DisconnectPlan>({
        kind: "disconnect",
        id: randomBytes(9).toString("base64url"),
        harness,
        ref,
        workspaceName: workspace,
        last,
        edits,
        notes,
        revoke,
        agent: connection.agent.handle,
        loginPath: revoke || logout ? login : null,
        logout,
        backupDir: this.backupDir(harness.id),
        warnings: [
          ...notes,
          ...(revoke ? [`The token “${revoke.label}” is revoked on the server.`] : []),
          ...(elsewhere.length > 0 ? [`${harness.name} keeps working in ${elsewhere.join(" and ")}.`] : []),
          ...(connection.methods.includes("mcp")
            ? [
                `${harness.name} keeps its own sign-in to Quadit's MCP server: sign it out there, or revoke it on the server.`,
              ]
            : []),
        ],
      });
      return { ok: true, plan: this.view(plan) };
    } catch (err) {
      if (err instanceof EditRefused) return { ok: false, error: err.message };
      throw err;
    }
  }

  /** Carries out a disconnect plan the person saw (waiting for any other Apply under way); gives what they should know. */
  applyDisconnect(planId: string): Promise<Disconnected | Refused> {
    const plan = this.plans.get(planId);
    this.plans.delete(planId);
    return this.inTurn(async () => {
      if (plan?.kind !== "disconnect")
        return { ok: false, error: "That plan is gone: review the changes again.", stale: true };
      const { ref } = plan;
      const stale = (): Refused | null => {
        const changed = changedSince(plan.edits);
        if (changed)
          return {
            ok: false,
            error: `${changed.path} changed since you reviewed the plan: review it again.`,
            stale: true,
          };
        const tool = this.ledger().harnesses[ref.tool];
        return this.find(this.ledger(), ref) && (tool?.connections.length === 1) === plan.last
          ? null
          : { ok: false, error: "That plan is gone: review the changes again.", stale: true };
      };
      const before = stale();
      if (before) return before;
      const origin = this.parts.server(ref.serverId)?.origin ?? "";
      // Quadit stops running the agent before its login is revoked, so that how its last run ended reaches the server
      // (agent-runs-contract.md §8.2): that agent of that workspace only. Not done yet: nothing else is, and the same
      // plan may be carried out again.
      const removed = plan.revoke
        ? await this.parts.removeRuns({ server: origin, workspace: ref.workspaceId, agent: ref.agentId })
        : { ok: true as const };
      if (!removed.ok) {
        this.plans.set(plan.id, plan);
        return {
          ok: false,
          error: removed.pending
            ? `Quadit is still telling the server how @${plan.agent}'s last run ended. Disconnect again in a moment.`
            : removed.error,
        };
      }
      // That can take a minute, in which the tool or the person may have changed a file of the plan.
      const after = plan.revoke && stale();
      if (after) return after;

      // The token, through its workspace's page; when that cannot, with the token itself (quadit logout --revoke).
      let unrevoked: Unrevoked | null = null;
      if (plan.revoke) {
        const revoked = await this.parts.ask(ref.serverId, ref.workspaceId, {
          kind: "revoke-token",
          token: plan.revoke.id,
        });
        if (!revoked.ok)
          unrevoked = {
            label: plan.revoke.label,
            agent: plan.agent,
            workspace: plan.workspaceName,
            server: this.parts.server(ref.serverId)?.name ?? "its server",
            reason: revoked.message,
          };
      }
      if (plan.logout) {
        const { binary, base } = plan.logout;
        const withToken = unrevoked && plan.revoke ? plan.revoke.id : null;
        const out = await this.parts.cli.logout(binary, base, ref.workspaceId, withToken).then(
          () => null,
          (err: Error) => err,
        );
        if (!out && withToken) unrevoked = null;
        // Refused with the token as well (its server is not reached): the login still goes, and the token is said.
        const left =
          out && withToken
            ? await this.parts.cli.logout(binary, base, ref.workspaceId, null).then(
                () => null,
                (err: Error) => err,
              )
            : out;
        if (left) return { ok: false, error: left.message };
      }
      const writes = plan.edits.filter((edit) => !edit.writtenBy);
      backUp(writes, plan.backupDir);
      writeEdits(writes);
      const ledger = this.ledger();
      const tool = ledger.harnesses[ref.tool];
      if (tool) {
        tool.connections = tool.connections.filter((c) => !sameRef(refOf(ref.tool, c), ref));
        if (tool.connections.length === 0) delete ledger.harnesses[ref.tool];
      }
      this.saveLedger(ledger);
      const key = connectionKey(ref);
      this.known.delete(key);
      this.codeRefused.delete(key);
      this.parts.disconnected(key);
      return { ok: true, notes: plan.notes, unrevoked };
    });
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.applying.then(work);
    this.applying = turn.catch(() => {});
    return turn;
  }

  private view(plan: Plan): PlanView {
    const { home } = this.parts;
    const login = plan.kind === "disconnect" ? plan.loginPath : null;
    const files: PlanFile[] = plan.edits.map((edit) => ({
      path: edit.path,
      shown: homely(home, edit.path),
      role: roleOf(edit, plan.harness, home, edit.writtenBy === true || edit.path === login),
      change:
        plan.kind === "connect"
          ? edit.before === null
            ? "new"
            : "edited"
          : edit.after === null
            ? "removed"
            : "restored",
      diff: diffOf(edit),
      ...(edit.writtenBy && plan.kind === "connect"
        ? { note: "Written by quadit login, which checks the token with the server first. The token is shown masked." }
        : {}),
    }));
    if (plan.kind === "connect") {
      for (const record of plan.shared) {
        files.push({
          path: record.path,
          shown: homely(home, record.path),
          role: roleOf(record, plan.harness, home, record.path === plan.worksAs?.login),
          change: "shared",
          diff: "",
          note: "Done already for another connected harness; shared with it.",
        });
      }
    }
    return { id: plan.id, files, warnings: plan.warnings };
  }

  private workspaceName(serverId: string, workspaceId: string): string {
    return (
      this.parts.summaries().find((s) => s.serverId === serverId && s.summary.workspace.id === workspaceId)?.summary
        .workspace.name ?? ""
    );
  }

  /** The connection `ref` names, and its tool's record; undefined when the ledger has none such. */
  private find(ledger: Ledger, ref: ConnectionRef): { tool: ToolRecord; connection: Connection } | undefined {
    const tool = ledger.harnesses[ref.tool];
    const connection = tool?.connections.find((c) => sameRef(refOf(ref.tool, c), ref));
    return tool && connection ? { tool, connection } : undefined;
  }

  /** The quadit command Connect runs: the one on the PATH, else the app's own copy. */
  private async binary(): Promise<string | null> {
    return (await this.parts.cli.look()).found?.path ?? this.parts.cli.bundled;
  }

  /** A tool's base login: the one recorded, else the computer's default login, as `binary` says where it is. */
  private async baseOf(tool: ToolRecord, binary: string): Promise<string | null> {
    if (tool.base) return tool.base;
    const defaultConfig = await this.parts.cli.defaultConfig(binary).catch(() => null);
    return defaultConfig && realPath(defaultConfig);
  }

  /** The targets of every tool's records but `except`'s. */
  private targets(ledger: Ledger, except: string | null): Set<string> {
    const found = new Set<string>();
    for (const [id, tool] of Object.entries(ledger.harnesses)) {
      if (id !== except) for (const record of tool.edits) found.add(targetOf(record));
    }
    return found;
  }

  private recordsByTarget(ledger: Ledger): Map<string, Applied> {
    const found = new Map<string, Applied>();
    for (const tool of Object.values(ledger.harnesses)) {
      for (const record of tool.edits) found.set(targetOf(record), record);
    }
    return found;
  }

  private backupDir(harnessId: string): string {
    return join(this.backupsDir, `${new Date().toISOString().replaceAll(":", "-")}-${harnessId}`);
  }

  /** The ledger, one from before several workspaces read as this one's (a tool's one connection its only one). */
  private ledger(): Ledger {
    const parsed = this.readLedger();
    return {
      harnesses: Object.fromEntries(Object.entries(parsed).map(([id, raw]) => [id, toolRecordOf(id, raw)])),
    };
  }

  /** Whether the ledger on disk is one from before several workspaces, not brought to this one yet. */
  private ledgerIsOld(): boolean {
    return Object.values(this.readLedger()).some((raw) => !isToolRecord(raw));
  }

  private readLedger(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(readFileSync(this.ledgerFile, "utf8")) as { harnesses?: unknown };
      if (parsed.harnesses && typeof parsed.harnesses === "object") return parsed.harnesses as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`${this.ledgerFile} cannot be read`, { cause: err });
    }
    return {};
  }

  private saveLedger(ledger: Ledger) {
    mkdirSync(dirname(this.ledgerFile), { recursive: true });
    const next = `${this.ledgerFile}.next`;
    writeFileSync(next, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    renameSync(next, this.ledgerFile);
  }
}

function isToolRecord(raw: unknown): raw is ToolRecord {
  return typeof raw === "object" && raw !== null && Array.isArray((raw as { connections?: unknown }).connections);
}

/**
 * A tool's record from what the ledger holds: as it is, or, from a ledger
 * from before several workspaces, its one connection made the tool's only
 * one. The agent of the workspace it works as there was recorded only for
 * a tool with a login of its own (made for the agent chosen there) in the
 * oldest ledgers; one on the computer's default login, which may be
 * another's, has none.
 */
function toolRecordOf(id: string, raw: unknown): ToolRecord {
  if (isToolRecord(raw)) return raw;
  const old = raw as OldConnection;
  const harness = HARNESSES.find((h) => h.id === id);
  return {
    edits: old.edits,
    ...(old.token ? { base: old.token.config } : {}),
    ...(old.allowed ? { allowed: true } : {}),
    connections: [
      {
        serverId: old.serverId,
        workspaceId: old.workspaceId,
        workspaceName: "",
        methods: old.methods,
        agent: old.agent,
        token: old.token ? { id: old.token.id, label: old.token.label } : null,
        member: old.member !== undefined ? old.member : harness?.env ? old.agent : null,
        code: old.code ?? null,
        ...(old.ran ? { ran: true as const } : {}),
        at: old.at,
      },
    ],
  };
}

/** The connection `c` of the tool `tool` (a harness id), as the pages name it. */
function refOf(tool: string, c: Connection): ConnectionRef {
  return { tool, serverId: c.serverId, workspaceId: c.workspaceId, agentId: c.agent.id };
}

function sameRef(a: ConnectionRef, b: ConnectionRef): boolean {
  return a.tool === b.tool && a.serverId === b.serverId && a.workspaceId === b.workspaceId && a.agentId === b.agentId;
}

/** The login file a connection's quadit uses: its own, else its tool's base, else the computer's default login. */
function loginFileOf(tool: ToolRecord, c: Connection, defaultConfig: string): string {
  return c.login ?? tool.base ?? realPath(defaultConfig);
}

const EMPTY_INDEX: LoginIndex = { connections: [], folders: [] };

/** The index, for what is only said: one that cannot be read says nothing. */
function safeIndex(folder: string): LoginIndex {
  try {
    return readIndex(folder);
  } catch {
    return EMPTY_INDEX;
  }
}

/**
 * Where `quadit login` puts a login of the workspace `slug` beside the base
 * login `base` (multi-workspace design §3.2, and its contract changes):
 * `<tool>-<slug>.json`, "workspace" for a slug of other letters, with -2 and
 * on when that is taken. The plan shows it; the quadit command decides.
 */
function addedLogin(base: string, slug: string): string {
  const stem = basename(base).replace(/\.json$/, "");
  const name = /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? slug : "workspace";
  const at = (n: number) => join(dirname(base), `${stem}-${name}${n > 1 ? `-${n}` : ""}.json`);
  let n = 1;
  while (existsSync(at(n))) n++;
  return at(n);
}

/** Whether two server addresses are the same server's: alike but for a trailing "/". */
function sameServer(a: string, b: string): boolean {
  return a !== "" && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Changes that let a tool use Quadit without asking, and the plain statement of what they let it do. */
interface AllowGroup {
  changes: Change[];
  said: string;
}

/**
 * Of what lets a tool use Quadit without asking, the changes to make (one
 * in place already makes nothing when planned), not one the app cannot make
 * (a setting of the person's in the way), which is said in `warnings`. Each
 * group's statement is said too, when any of it holds.
 */
function allowable(groups: AllowGroup[], warnings: string[]): Change[] {
  const make: Change[] = [];
  for (const group of groups) {
    let holds = false;
    for (const change of group.changes) {
      try {
        planChanges([change]);
        make.push(change);
        holds = true;
      } catch (err) {
        if (!(err instanceof EditRefused)) throw err;
        warnings.push(err.message);
      }
    }
    if (holds) warnings.push(group.said);
  }
  return make;
}

/**
 * What a file is to a plan, from the kind of change that made it (or the
 * record of it): `login`, it is the quadit login the plan makes or takes back,
 * the tool's own or, for a tool without a setting for one, the computer's default.
 */
function roleOf(
  { kind, path }: { kind: FileEdit["kind"]; path: string },
  harness: Harness,
  home: string,
  login: boolean,
): FileRole {
  if (login || kind === "written-by") return harness.env ? "login" : "shared-login";
  if (harness.rules && path === realPath(join(home, harness.rules.file))) return "rules";
  if (harness.rules && path === realPath(join(home, harness.rules.folder))) return "rules-folder";
  switch (kind) {
    case "file":
      return "skill";
    case "json":
    case "json-item":
    case "toml":
      return "settings";
    case "link":
      return "command";
    case "folder":
      return "folder";
    case "line":
      return "profile";
    case "path":
      return "path";
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
 * know), or, without one, the install script; on Windows, where an app of
 * this build always has its copy, the release's zip. None needs an
 * administrator.
 */
function manualInstall(bundled: string | null, platform: NodeJS.Platform): string {
  if (platform === "win32")
    return bundled
      ? `add ${win32.dirname(bundled)} to your PATH`
      : "download quadit_windows_amd64.zip (or arm64) from https://github.com/agrigoryan/quadit/releases, and add the folder of its quadit.exe to your PATH";
  return bundled
    ? `mkdir -p ~/.local/bin && ln -s '${bundled}' ~/.local/bin/quadit, then add ~/.local/bin to your PATH`
    : "curl -fsSL https://raw.githubusercontent.com/agrigoryan/quadit/main/install.sh | sh";
}

/** `path` as a person writes it: ~ for the home folder, whichever separator the path has after it (Windows: \\). */
export function homely(home: string, path: string): string {
  const after = path.slice(home.length, home.length + 1);
  return path.startsWith(home) && (after === "" || after === "/" || after === "\\")
    ? `~${path.slice(home.length)}`
    : path;
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

/**
 * The records a plan will leave once written: a file's with the hash of what
 * it will hold (what `quadit login` wrote, once it has) and its backup.
 */
function hashed(applied: Applied[], edits: FileEdit[], backups: Map<string, string>): Applied[] {
  return applied.map((record) => {
    if (record.kind !== "file") return record;
    const edit = edits.find((e) => e.path === record.path);
    const text = edit?.writtenBy ? readText(record.path) : edit?.after;
    return { ...record, sha256: sha256(text ?? ""), backup: backups.get(record.path) ?? null };
  });
}

/**
 * Writes `edits`; when one cannot be written, takes back what of `records`
 * is in place (what it wrote so far) and throws: a half-made change is
 * never left for the person's.
 */
function writeOrTakeBack(edits: FileEdit[], records: Applied[]) {
  try {
    writeEdits(edits);
  } catch (err) {
    writeEdits(planReverts(records).edits);
    throw err;
  }
}
