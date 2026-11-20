// What the app's own bundled pages (Welcome, the server list, the sign-in
// bar, the connection error, setup, Connect, the menu-bar panel and quick capture)
// may ask of the app, through the preload src/preload/pages.ts. The server's
// web pages never see this: they get only the bridge of the contract.

import type { DesktopOutcome, DesktopSummary } from "@/shared/bridge";

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

export interface ConnectChoice {
  harness: string;
  serverId: string;
  workspaceId: string;
  methods: ConnectMethod[];
  /** Null where no choice would hold: the quadit command alone, working as a default login already there. */
  agent: { id: string } | { create: { name: string; handle: string } } | null;
  /** Let the harness use quadit without asking each time, where it has a setting for that. */
  allowUnattended: boolean;
}

/** Every file a plan changes, as a diff, the folder its backups go to, and what the person should know first. */
export interface PlanView {
  id: string;
  files: { path: string; diff: string; note?: string }[];
  backupDir: string;
  warnings: string[];
}

export type Planned = { ok: true; plan: PlanView } | { ok: false; error: string };

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
   * Sets Quadit up on this computer: starts the server here (or the one set
   * up before), makes its owner, named `name`, and opens its window on their
   * workspace, signed in; on one set up already, signs in instead.
   */
  setUpHere(name: string): Promise<{ ok: true } | { ok: false; error: string }>;
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

  /** Shows Welcome, where Quadit is set up on this computer or a server is connected to. */
  showWelcome(): Promise<void>;
  /** The full name of the person's account on this computer, which Welcome offers as their name. */
  accountName(): Promise<string>;

  setupState(): Promise<SetupState>;
  saveSetup(s: { setupDone?: boolean; captureShortcut?: boolean }): Promise<SetupState>;
  testNotification(): Promise<void>;
  /** Opens the system's notification settings; false where the app knows none to open. */
  openNotificationSettings(): Promise<boolean>;
  openConnect(): Promise<void>;

  connectState(): Promise<ConnectView>;
  planConnect(c: ConnectChoice): Promise<Planned>;
  applyConnect(planId: string): Promise<{ ok: true; hint: string } | { ok: false; error: string }>;
  planDisconnect(harness: string): Promise<Planned>;
  /** Drops the plan under review (Cancel). */
  dropPlan(): Promise<void>;
  applyDisconnect(planId: string): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }>;
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
