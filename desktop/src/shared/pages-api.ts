// What the app's own bundled pages (the first run, the server list, the sign-in
// bar, the connection error, setup, Connect agents, the menu-bar panel and quick capture)
// may ask of the app, through the preload src/preload/pages.ts. The server's
// web pages never see this: they get only the bridge of the contract.

import type { DesktopOutcome, DesktopSummary, HeardListener } from "@/shared/bridge";

export interface ServerView {
  id: string;
  name: string;
  origin: string;
  /** How its address carries what is said: see src/main/origins.ts, transportOf. */
  transport: "secure" | "local" | "insecure";
  /** Whether it is the server the app runs on this computer (LocalServerView). */
  local: boolean;
}

/** Where the server the app runs on this computer stands (src/main/local-server.ts). */
export type LocalState =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "running" }
  /** `log` is the last lines of the server's log. */
  | { kind: "failed"; reason: string; log: string[] };

export type LocalControl = "start" | "stop" | "restart";

/** The server the app can run on this computer. */
export interface LocalServerView {
  /** Whether this build can run one: macOS and Linux, with the server inside the app. */
  available: boolean;
  /** Its id in the server list; null when it is not in the list (never set up, or removed). */
  serverId: string | null;
  state: LocalState;
  /** Its data folder, kept when it is removed from the list. */
  dataDir: string;
  /** It was set up before and removed from the list: running it again uses the data it left. */
  dataKept: boolean;
  /** Whether the app starts when the person logs in; null where the app does not offer it (it does on macOS only). */
  openAtLogin: boolean | null;
}

/** How a server answered just now; see src/main/probe.ts for what each fit means. */
export type ServerStatus =
  { reachable: true; version: string; fit: "ok" | "old-server" | "new-server" } | { reachable: false; reason: string };

/** `insecure`: refused only because the address is plain http elsewhere; asking again with allowInsecure adds it. */
export type AddResult = { ok: true; server: ServerView } | { ok: false; error: string; insecure?: true };

/** A quadit://open link named a server that is not added yet: the server list offers to add it. */
export interface Invitation {
  origin: string;
}

/** A workspace one of a server's windows shows, as its page published it. */
export interface SummaryView {
  serverId: string;
  serverName: string;
  summary: DesktopSummary;
  /** Whether its page takes requests: a server whose web app is older than the app's does not. */
  listening: boolean;
}

export interface SetupState {
  setupDone: boolean;
  captureShortcut: boolean;
  /** The quick-capture key, as Electron names it. */
  shortcut: string;
  /** Why the key could not be taken, when it is on and could not be. */
  shortcutError?: string;
  /** The servers a window has shown a workspace of: signed in. */
  signedIn: string[];
}

/**
 * How a chat of a tool listens (main/harnesses.ts): "background", the chat
 * stays free; "busy", listening keeps that chat busy.
 */
export type ChatListens = "background" | "busy";

/** An agent tool as the first run shows it: its name, its tile's letters, and whether it is on this computer. */
export interface ToolView {
  id: string;
  name: string;
  initials: string;
  found: boolean;
  /** Whether connecting gives it a quadit login of its own (else it uses this computer's: HarnessView's cliIdentity). */
  ownLogin: boolean;
  /**
   * For a tool without a login of its own, when this computer has a default
   * quadit login already: whom it works as, as a person reads it ("@ann on
   * https://q.example"); connecting makes no agent for it. Null otherwise.
   */
  worksAs: string | null;
  /** Whether an agent in it was seen to listen (main/harnesses.ts); its card says so when not. */
  listenVerified: boolean;
  /** How a chat of it listens; absent where not verified. */
  chatListens?: ChatListens;
  /** Whether connecting also lets it run quadit without asking each time (it has settings for that, which Connect writes). */
  allows: boolean;
}

/** The agent tools as the first run finds them, and whether connecting one puts the quadit command on this computer too. */
export interface FoundTools {
  tools: ToolView[];
  addsCommand: boolean;
}

export type CaptureWhat = "task" | "page";

/** Where quick capture puts what it makes; the last one is offered again. */
export interface CaptureTarget {
  serverId: string;
  workspaceId: string;
  /** A project's key; null for no project, which only a page may have. */
  project: string | null;
  what: CaptureWhat;
}

export type ConnectMethod = "cli" | "mcp";

export interface HarnessView {
  id: string;
  name: string;
  /** The letters on its tile (the app shows no logos). */
  initials: string;
  /** Its config folder or its command is on this computer. */
  installed: boolean;
  /** Whether it can connect through MCP. */
  mcp: boolean;
  /**
   * Who the quadit command works as in it: "own", its own agent (the app
   * sets QUADIT_CONFIG in its settings, which its commands are known to
   * see); "default", the computer's default login.
   */
  cliIdentity: "own" | "default";
  /** Whether an agent in it was seen to listen (main/harnesses.ts). */
  listenVerified: boolean;
  /** How a chat of it listens; absent where not verified. */
  chatListens?: ChatListens;
  /** Whether connecting also lets it run quadit without asking each time (it has settings for that, which Connect writes). */
  allows: boolean;
  /** Connected, its Quadit skill was changed by hand since the app wrote it, so the app does not update it by itself. */
  skillChangedByHand: boolean;
  connected: { methods: ConnectMethod[]; server: string; workspace: string; agent: string } | null;
}

export interface ConnectView {
  /** Connect needs the quadit command, which exists for macOS and Linux only. */
  supported: boolean;
  harnesses: HarnessView[];
  cli: {
    /** The quadit command on the login shell's PATH, and its version; null when there is none. */
    found: string | null;
    version: string;
    /** Without one: the folder the app's own copy would be linked into, or the command to run by hand. */
    linkInto: string | null;
    /** The profile of the login shell that connecting adds the line putting `linkInto` on the PATH to; null when none is needed. */
    profile: string | null;
    manual: string | null;
  };
  /**
   * The computer's default login, when there is one: its server, and the
   * agent it is (null when its server could not be asked). The harnesses
   * without a login of their own work as it.
   */
  defaultLogin: { server: string | null; agent: string | null } | null;
  /** The Quadit plugin for Claude Code is installed: its MCP entry needs QUADIT_URL and QUADIT_TOKEN. */
  claudePlugin: boolean;
}

/**
 * Where a tool Connect set up stands with Quadit (desktop contract §11), as
 * the server says of the agent it works as (main/handshake.ts):
 *   waiting    set up on this computer, and the agent has not proven yet
 *              that it reached Quadit from inside the tool; `code` is the
 *              open connect code for it to give back, null when there is
 *              none (gone, run out, or the tool was connected by an older
 *              version of the app), for which a new one is to be made;
 *              `refused` is why the last code asked for was not made;
 *   connected  the server says it proved it, and whether it listens now
 *              (null: cannot tell right now, no answer came since), with,
 *              while it listens, what does (`heard`; absent where the
 *              server's page does not say);
 *   unknown    set up; whether it reached Quadit is not known here: the
 *              server has not answered yet, or the tool works as a login
 *              this server does not know (another server's), which the app
 *              never asks it about.
 */
export type Handshake =
  | { state: "waiting"; code: string | null; refused?: string }
  | { state: "connected"; listening: boolean | null; heard?: Heard; owner?: Owner }
  | { state: "unknown" };

/** Who answers for a connected agent: their handle (without "@"), and whether they are the person signed in in its workspace's window. */
export interface Owner {
  handle: string;
  me: boolean;
}

/**
 * What listens as a connected agent: each live listener (of a project, or,
 * without one, of everything else) and what holds it; whether a webhook
 * pushes to it; the projects (keys) nothing hears now.
 */
export interface Heard {
  listeners: HeardListener[];
  pushed: boolean;
  unheard: string[];
}

/**
 * What the app does by itself for a tool Connect set up (desktop contract
 * §11, third amendment, main/self-runs.ts): `proving`, giving its connect
 * code back by running it once, while it runs, or why it could not (the
 * card then shows the line to paste), null otherwise.
 */
export interface SelfRun {
  proving: { state: "running" } | { state: "failed"; reason: string } | null;
}

/** A program Quadit runs for an agent (agent-runs-contract.md §1): Claude Code or Codex. */
export type RunProgram = "claude" | "codex";

/** Why the runner holds back an entry's items (agent-runs-contract.md §2.2). */
export type RunPause =
  "usage_limit" | "not_signed_in" | "program_missing" | "folder_missing" | "login_mismatch" | "server_old";

/**
 * One project Quadit runs an agent for on this computer (an entry of
 * `quadit run`'s registry, agent-runs-contract.md §5.1) and what it does
 * now, as `quadit run list --json` says (§5.12). `not_served`: no runner
 * of the app's serves the registry now; its message is the card's line.
 * `blocked`: writes the server refused for good, by the run's task.
 */
export interface RunEntryView {
  id: string;
  /** The project's key. */
  project: string;
  /** The folder, with ~ for the home folder. */
  folder: string;
  program: RunProgram;
  status:
    | { state: "starting" | "ready" | "aside" | "removing" }
    | { state: "working"; task: string }
    | { state: "paused"; pause: RunPause; until?: string }
    | { state: "error"; message: string }
    | { state: "not_served"; message: string };
  blocked: { task: string; error: string }[];
}

/**
 * "Run by Quadit" on a tool's card (agent-runs-contract.md §8.2): the agent
 * Quadit runs the tool as ("@claude"), and the projects it runs it for on
 * this computer.
 */
export interface RunsView {
  agent: string;
  entries: RunEntryView[];
  /** The list of what Quadit runs could not be read now (entries is then empty, not known). */
  unreadable?: true;
}

/**
 * The window Connect agents is laid over: its server, the workspace its page
 * shows (null: none yet, or signed out), and whether that server's page
 * asked for Connect (`openedByPage`), a server other than the app's own,
 * not the person.
 */
export interface ConnectTarget {
  serverId: string;
  serverName: string;
  summary: DesktopSummary | null;
  openedByPage: boolean;
  /** Where the page that asked for it wants it to open; absent: as it opens by itself. */
  focus?: ConnectFocusView;
}

/**
 * Where Connect agents opens, as the page that asked wants it (the bridge's
 * ConnectFocus), resolved here: `tool`, the tool that works as that agent on
 * this computer, whose card is shown ready for `intent`; else `agent`, that
 * agent of the workspace, which a Connect then makes a tool work as. `id`
 * tells one ask from the next: each is done once.
 */
export interface ConnectFocusView {
  id: number;
  intent?: "connect" | "run" | "disconnect";
  tool?: string;
  agent?: { id: string; handle: string };
}

export interface ConnectChoice {
  harness: string;
  serverId: string;
  workspaceId: string;
  methods: ConnectMethod[];
  /** Null where no choice would hold: the quadit command alone, working as a default login already there. */
  agent: { id: string } | { create: { name: string; handle: string } } | null;
}

/**
 * What a file is to a plan, which says in plain words what it is for
 * (shared/change-words.ts): the skill, the tool's own login, the computer's
 * default login (which the tool works as), the tool's settings, the link that
 * puts the quadit command on the PATH, the folder made for it, the line in
 * the shell's profile, the tool's command rules and the folder made for them.
 */
export type FileRole =
  "skill" | "login" | "shared-login" | "settings" | "command" | "folder" | "profile" | "rules" | "rules-folder";

/**
 * What a plan does to a file: makes it, edits it, takes it away, or puts it
 * back as it was; "shared": nothing, since another connected tool's
 * connection did it already and shares it.
 */
export type FileChange = "new" | "edited" | "removed" | "restored" | "shared";

export interface PlanFile {
  path: string;
  /** The path as a person writes it: ~ for the home folder. */
  shown: string;
  role: FileRole;
  change: FileChange;
  diff: string;
  note?: string;
}

/** Every file a plan changes, as a diff, and what the person should know first. */
export interface PlanView {
  id: string;
  files: PlanFile[];
  warnings: string[];
}

export type Planned = { ok: true; plan: PlanView } | { ok: false; error: string };

/**
 * A token a disconnect could not revoke (the server refused, or did not
 * answer): the tool no longer uses it, but it still works until the person
 * revokes it. `label` is the token's name as Quadit lists it under the
 * agent's tokens; `agent` that agent's handle; `server` the server's name in
 * the app; `reason` what was said.
 */
export interface Unrevoked {
  label: string;
  agent: string;
  server: string;
  reason: string;
}

/** What a disconnect leaves the person to know: files it left as they were, and a token still to revoke. */
export interface Disconnected {
  ok: true;
  notes: string[];
  unrevoked: Unrevoked | null;
}

/** Why something was refused; `stale`: the plan the person saw is gone or out of date, and they should look again. */
export type Refused = { ok: false; error: string; stale?: true };

export interface PagesApi {
  listServers(): Promise<ServerView[]>;
  checkServer(id: string): Promise<ServerStatus>;
  /** Adds a server; one at a plain http address beyond this computer and private networks only with `allowInsecure`. */
  addServer(address: string, name: string, allowInsecure?: boolean): Promise<AddResult>;
  removeServer(id: string): Promise<void>;
  openServer(id: string): Promise<void>;
  /** Starts the sign-in through the system browser for that server. */
  signIn(id: string): Promise<void>;
  /** The pending invitation from a link, given once. */
  takeInvitation(): Promise<Invitation | null>;
  /** Calls `listener` when the list of servers changes or an invitation arrives. */
  onChanged(listener: () => void): void;
  /** Hides the sign-in bar of the window it sits in. */
  dismissSignInBar(): void;
  /** Loads again the server's page that the connection error it sits over is about. */
  retryServer(): void;

  localServer(): Promise<LocalServerView>;
  /**
   * The first run's Welcome (desktop contract §10): sets Quadit up on this
   * computer, starting the server here (or the one set up before), making its
   * owner, named `name`, and loading its workspace in the window the first run
   * shows over. `next`: "tools", the install is new and the first run goes on
   * to its tools step; "workspace", it was set up before (its data kept), the
   * app signed in, and the first run is over.
   */
  setUpHere(name: string): Promise<{ ok: true; next: "tools" | "workspace" } | { ok: false; error: string }>;
  /**
   * The first run's other way: adds the server at `address` (as addServer),
   * whose window, the one the first run showed over, opens on its sign-in
   * page; that ends the first run.
   */
  connectServer(address: string, allowInsecure?: boolean): Promise<AddResult>;
  /** The agent tools Connect knows, and which are on this computer; takes at least about a second. */
  lookForTools(): Promise<FoundTools>;
  /**
   * Connects a tool lookForTools found: with the plan toolChanges showed when
   * `planId` is that one's, else with the defaults and nothing asked. Gives
   * the handle of the workspace's agent it works as (null: none of this workspace).
   */
  connectTool(id: string, planId?: string): Promise<{ ok: true; agent: string | null } | Refused>;
  /** Takes back what connectTool did (its Undo); gives what the person should know (a token to revoke by hand). */
  disconnectTool(id: string): Promise<Disconnected | Refused>;
  /** What connecting one of those tools changes: the plan as it would be (kept for connectTool), or as it was carried out. */
  toolChanges(id: string): Promise<Planned>;
  /**
   * Ends the tools step, once what was asked before is done: the workspace's
   * page is asked for its sample tasks and the window shows them, under the
   * first run. A failure is said, and the step can be ended again.
   */
  finishFirstRun(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Where the first run starts: Welcome, or, resumed after the account was made, the tools step for `person`. */
  firstRunStep(): Promise<{ step: "welcome" } | { step: "tools"; person: string }>;
  /** Takes the first run away, showing the window under it; it never comes back by itself. */
  endFirstRun(): Promise<void>;
  controlLocalServer(control: LocalControl): Promise<void>;
  /** Shows the local server's data folder, or its log, in the system's file manager. */
  showLocalServerFiles(what: "data" | "log"): Promise<void>;
  setOpenAtLogin(on: boolean): Promise<void>;

  /** The workspaces the server windows show now. */
  summaries(): Promise<SummaryView[]>;
  /** Opens a server's window at `path`, a page of its web app. */
  openPath(serverId: string, path: string): Promise<void>;
  /** The panel's button on a decision waiting on the person. */
  act(serverId: string, workspaceId: string, action: { request: string; text?: string }): Promise<DesktopOutcome>;

  /** Makes a task or a page through the workspace's window, and remembers where. */
  capture(c: CaptureTarget & { title: string; body: string }): Promise<DesktopOutcome>;
  lastCapture(): Promise<CaptureTarget | null>;

  /** Shows the first run's Welcome, where Quadit is set up on this computer or a server is connected to. */
  showWelcome(): Promise<void>;
  /** The full name of the person's account on this computer, which Welcome offers as their name. */
  accountName(): Promise<string>;

  setupState(): Promise<SetupState>;
  saveSetup(s: { setupDone?: boolean; captureShortcut?: boolean }): Promise<SetupState>;
  testNotification(): Promise<void>;
  /** Opens the system's notification settings; false where the app knows none to open. */
  openNotificationSettings(): Promise<boolean>;
  /** Opens Connect agents over a server's window (the one in front, else one of the app's servers). */
  openConnect(): Promise<void>;

  /** The window this Connect agents page is laid over; null for any other page. */
  connectTarget(): Promise<ConnectTarget | null>;
  /** Takes this Connect agents page away, showing the page under it ("Done", Escape). */
  closeConnect(): Promise<void>;
  /** Where a tool Connect has set up stands with Quadit; null when it is not set up. */
  toolHandshake(id: string): Promise<Handshake | null>;
  /** Makes a new connect code for a tool Connect has set up, replacing the one it had. */
  newConnectCode(id: string): Promise<{ ok: true } | Refused>;
  /** What the app does by itself for a tool Connect set up (main/self-runs.ts); null when it is not set up. */
  toolSelf(id: string): Promise<SelfRun | null>;
  /** Opens the log of what the app ran for a tool. */
  showToolLog(id: string): Promise<void>;
  /**
   * Run by Quadit for a tool: its agent and the projects Quadit runs it for
   * on this computer, with what each does now; null when Quadit cannot run
   * it (not Claude Code or Codex, no login of its own, no quadit in the app).
   */
  runEntries(toolId: string): Promise<RunsView | null>;
  /** The projects the tool's agent may work in. */
  agentProjects(toolId: string): Promise<{ ok: true; projects: { key: string; name: string }[] } | Refused>;
  /** The native folder picker over the page's window: the folder chosen, and as a person writes it (~); null when cancelled. */
  pickFolder(): Promise<{ path: string; shown: string } | null>;
  /** Has Quadit run the tool's agent for `project` in `folder` (quadit run add); the runner is started if it was not running. */
  startRunning(toolId: string, project: string, folder: string): Promise<{ ok: true } | Refused>;
  /** Has Quadit stop running the tool's agent for the entry `entryId` (quadit run remove), waiting for it to be done. */
  stopRunning(toolId: string, entryId: string): Promise<{ ok: true } | Refused>;
  /** Opens the runner's log (runner/runner.log). */
  showRunnerLog(): Promise<void>;
  /** Writes the app's Quadit skill over a connected tool's one the person changed by hand. */
  updateSkill(id: string): Promise<{ ok: true } | Refused>;
  /** Puts `text` on the clipboard (a connect code's line). */
  copyText(text: string): Promise<void>;
  connectState(): Promise<ConnectView>;
  planConnect(c: ConnectChoice): Promise<Planned>;
  /** `stale`: the plan is gone or a file changed since: look again. */
  applyConnect(planId: string): Promise<{ ok: true; hint: string } | Refused>;
  planDisconnect(harness: string): Promise<Planned>;
  /** Drops the plan under review (Cancel). */
  dropPlan(): Promise<void>;
  applyDisconnect(planId: string): Promise<Disconnected | Refused>;
  showBackups(): Promise<void>;
}

/** The IPC channels of this API: "pages:" and the method's name, and the one the app sends changes on. */
export const PAGES_CHANNEL = "pages:";
export const PAGES_CHANGED = "pages:changed";

declare global {
  interface Window {
    quaditPages?: PagesApi;
  }
}
