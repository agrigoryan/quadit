// The desktop bridge as the contract fixes it (section 3, and section 5 with
// the shapes of desktop-features-design.md, section B), the IPC channels the
// preload uses to carry it to the main process, and the shape a message
// must have to be kept. Both sides hold a message to that shape: the preload
// so that a page cannot make the app copy megabytes across, the main process
// because the preload is the page's process and cannot be trusted.
//
// One rule for every shape: text that is only shown is cut short; a string
// the app hands back or uses as an address (a request, a path, an id, a key)
// refuses the whole message when it is too long, since cut short it would
// mean something else; a long list keeps its first items.

/** A button the page defines; the app hands `request` back unchanged when the person presses it. */
export interface DesktopAction {
  label: string;
  request: string;
}

export interface DesktopNotification {
  title: string;
  body: string;
  /** Where clicking it goes: a path on the same server, starting with "/". */
  path: string;
  /** A notification with the tag of an earlier one replaces it. */
  tag?: string;
  /** The inbox item's id: the app shows each once, whichever of a server's windows tells it. */
  id?: string;
  /** Buttons on the notification (macOS only; ignored elsewhere). */
  actions?: DesktopAction[];
  /** An inline reply field (macOS only); the text typed comes back with `request`. */
  reply?: { placeholder: string; request: string };
}

export type AgentState = "working" | "waiting" | "has_work" | "idle";

/** What a window's workspace looks like to the app's own pages (the panel, quick capture, Connect). */
export interface DesktopSummary {
  workspace: { id: string; slug: string; name: string };
  me: { name: string; canCreateAgents: boolean };
  /** Decisions waiting on me, newest first. */
  waiting: { title: string; detail: string; path: string; actions: DesktopAction[] }[];
  /** Agents in the workspace; `usable`: I may let a client work as it (responsible for it, or admin). */
  agents: {
    id: string;
    handle: string;
    name: string;
    state: AgentState;
    detail: string;
    path: string;
    usable: boolean;
  }[];
  /** Projects I may create tasks in, for quick capture. */
  projects: { key: string; name: string }[];
}

/** What the person asked for in the app, handed to the page that is to do it. */
export type DesktopRequest =
  | { kind: "action"; request: string; text?: string }
  | { kind: "capture"; project: string | null; what: "task" | "page"; title: string; body: string }
  | { kind: "agent"; create: { name: string; handle: string } }
  | { kind: "agent-token"; agent: string; label: string }
  | { kind: "revoke-token"; token: string }
  /**
   * The end of the first run (desktop contract §10): the workspace's sample
   * tasks, the third handed to `agent` (a member id) when given; the outcome's
   * path is the "Getting started" project's task list.
   */
  | { kind: "samples"; agent?: string };

export type DesktopOutcome =
  | {
      ok: true;
      path?: string;
      agent?: { id: string; handle: string; name: string };
      token?: { id: string; secret: string };
    }
  | { ok: false; message: string; path?: string };

export interface QuaditDesktop {
  /** App version, e.g. "0.1.0". */
  version: string;
  /** Show a native notification; clicking it focuses the window and navigates to `path`. */
  notify(n: DesktopNotification): void;
  /**
   * The unread count of `workspace` (its id), the one this window shows; 0
   * is a count like any other. Without a workspace, the window shows none
   * and its count is taken back. The app counts each workspace of a server
   * once (its newest report) and adds the servers up for the dock and tray badge.
   */
  setBadge(count: number, workspace?: string): void;
  /** Replaces this window's summary; null takes it back (signed out, shell gone). */
  publish(summary: DesktopSummary | null): void;
  /** The one handler for requests the person made in the app; gives the function that stops it. */
  onRequest(handler: (request: DesktopRequest) => Promise<DesktopOutcome>): () => void;
  /** Opens the app's Connect agents window for this server. Present only where the app can connect tools (not on Windows). */
  openConnect?(): void;
}

export const BRIDGE_NOTIFY = "bridge:notify";
export const BRIDGE_BADGE = "bridge:badge";
/** Page to app: a summary, or null. */
export const BRIDGE_PUBLISH = "bridge:publish";
/** App to page: `{id, request}`. */
export const BRIDGE_REQUEST = "bridge:request";
/** Page to app: `{id, outcome}`. */
export const BRIDGE_OUTCOME = "bridge:outcome";
/** Page to app: whether the page has a request handler now. */
export const BRIDGE_LISTENING = "bridge:listening";
/** Page to app: open the Connect agents window (no payload). */
export const BRIDGE_OPEN_CONNECT = "bridge:open-connect";
/**
 * The preload to the app, synchronously: the origin of the server whose
 * window it runs in ("" when none). Asked at each page load, so a window made
 * before its server is known (the first run's) gets it once it is.
 */
export const BRIDGE_ORIGIN = "bridge:origin";

const TITLE_MAX = 200;
const BODY_MAX = 1000;
const PATH_MAX = 2048;
const ID_MAX = 200;
const COUNT_MAX = 99_999;
const LABEL_MAX = 40;
const REQUEST_MAX = 500;
const PLACEHOLDER_MAX = 80;
const MESSAGE_MAX = 500;
const SECRET_MAX = 500;
const NOTE_ACTIONS_MAX = 3;
const WAITING_MAX = 20;
const WAITING_ACTIONS_MAX = 6;
const AGENTS_MAX = 50;
const PROJECTS_MAX = 200;
/** The longest reply text the app hands to a page. */
export const REPLY_MAX = 10_000;

const AGENT_STATES: readonly string[] = ["working", "waiting", "has_work", "idle"] satisfies AgentState[];

/** Thrown by the readers below when a message is not kept; caught only by `kept`. */
const refused = new Error("refused");

function kept<T>(read: () => T): T | null {
  try {
    return read();
  } catch (err) {
    if (err === refused) return null;
    throw err;
  }
}

function record(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw refused;
  return raw as Record<string, unknown>;
}

/** Text that is only shown: cut short. */
function shown(raw: unknown, max: number): string {
  if (typeof raw !== "string") throw refused;
  return raw.slice(0, max);
}

/** A string handed back or used as an address: refused when too long. */
function exact(raw: unknown, max: number): string {
  if (typeof raw !== "string" || raw.length > max) throw refused;
  return raw;
}

function optional<T>(raw: unknown, read: (raw: unknown) => T): T | undefined {
  return raw === undefined ? undefined : read(raw);
}

function flag(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw refused;
  return raw;
}

function list<T>(raw: unknown, max: number, item: (raw: unknown) => T): T[] {
  if (!Array.isArray(raw)) throw refused;
  return raw.slice(0, max).map(item);
}

/** `value` without the keys whose value is undefined, so an absent field stays absent. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function actionOf(raw: unknown): DesktopAction {
  const { label, request } = record(raw);
  return { label: shown(label, LABEL_MAX), request: exact(request, REQUEST_MAX) };
}

/**
 * `raw` as a notification the app keeps, or null when it is none: strings
 * only, nothing coerced. A path, tag or id too long refuses it, since cut
 * short it would name another page, or replace another notification.
 */
export function notificationOf(raw: unknown): DesktopNotification | null {
  return kept(() => {
    const { title, body, path, tag, id, actions, reply } = record(raw);
    return defined({
      title: shown(title, TITLE_MAX),
      body: shown(body, BODY_MAX),
      path: exact(path, PATH_MAX),
      tag: optional(tag, (v) => exact(v, ID_MAX)),
      id: optional(id, (v) => exact(v, ID_MAX)),
      actions: optional(actions, (v) => list(v, NOTE_ACTIONS_MAX, actionOf)),
      reply: optional(reply, (v) => {
        const { placeholder, request } = record(v);
        return { placeholder: shown(placeholder, PLACEHOLDER_MAX), request: exact(request, REQUEST_MAX) };
      }),
    });
  });
}

/** `raw` as a badge report the app keeps (a whole count, from 0 up to a ceiling; "" for no workspace), or null when it is none. */
export function badgeOf(raw: unknown): { count: number; workspace: string } | null {
  return kept(() => {
    const { count, workspace } = record(raw);
    if (typeof count !== "number" || !Number.isFinite(count)) throw refused;
    return { count: Math.min(Math.max(Math.floor(count), 0), COUNT_MAX), workspace: exact(workspace, ID_MAX) };
  });
}

/** `raw` as a summary the app keeps, as fresh plain data, or null when it is none. */
export function summaryOf(raw: unknown): DesktopSummary | null {
  return kept(() => {
    const { workspace, me, waiting, agents, projects } = record(raw);
    const ws = record(workspace);
    const person = record(me);
    return {
      workspace: { id: exact(ws.id, ID_MAX), slug: exact(ws.slug, ID_MAX), name: shown(ws.name, TITLE_MAX) },
      me: { name: shown(person.name, TITLE_MAX), canCreateAgents: flag(person.canCreateAgents) },
      waiting: list(waiting, WAITING_MAX, (v) => {
        const item = record(v);
        return {
          title: shown(item.title, TITLE_MAX),
          detail: shown(item.detail, BODY_MAX),
          path: exact(item.path, PATH_MAX),
          actions: list(item.actions, WAITING_ACTIONS_MAX, actionOf),
        };
      }),
      agents: list(agents, AGENTS_MAX, (v) => {
        const agent = record(v);
        if (typeof agent.state !== "string" || !AGENT_STATES.includes(agent.state)) throw refused;
        return {
          id: exact(agent.id, ID_MAX),
          handle: exact(agent.handle, ID_MAX),
          name: shown(agent.name, TITLE_MAX),
          state: agent.state as AgentState,
          detail: shown(agent.detail, BODY_MAX),
          path: exact(agent.path, PATH_MAX),
          usable: flag(agent.usable),
        };
      }),
      projects: list(projects, PROJECTS_MAX, (v) => {
        const project = record(v);
        return { key: exact(project.key, ID_MAX), name: shown(project.name, TITLE_MAX) };
      }),
    };
  });
}

/** `raw` as a page's answer to a request, as fresh plain data, or null when it is none. */
export function outcomeOf(raw: unknown): DesktopOutcome | null {
  return kept((): DesktopOutcome => {
    const { ok, path, message, agent, token } = record(raw);
    const where = optional(path, (v) => exact(v, PATH_MAX));
    if (ok === false) return defined({ ok, message: shown(message, MESSAGE_MAX), path: where });
    if (ok !== true) throw refused;
    return defined({
      ok,
      path: where,
      agent: optional(agent, (v) => {
        const a = record(v);
        return { id: exact(a.id, ID_MAX), handle: exact(a.handle, ID_MAX), name: shown(a.name, TITLE_MAX) };
      }),
      token: optional(token, (v) => {
        const t = record(v);
        return { id: exact(t.id, ID_MAX), secret: exact(t.secret, SECRET_MAX) };
      }),
    });
  });
}

/** The command-line switch through which a server window's preload learns the app version. */
export const VERSION_SWITCH = "--quadit-version=";

declare global {
  interface Window {
    quaditDesktop?: QuaditDesktop;
  }
}
