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
    /** The first line of its card on the Agents page, coloured as there; absent from an older page. */
    line?: { text: string; tone: "ok" | "work" | "wait" | "quiet" };
    /** How far it is heard: not connected, connected and nothing hears it, or heard; absent from an older page. */
    reach?: "not_connected" | "not_listening" | "heard";
  }[];
  /** Projects I may create tasks in, for quick capture. */
  projects: { key: string; name: string }[];
  /** How many more decisions wait on me than `waiting` holds (it holds at most 10). */
  waitingMore?: number;
  /** Tasks that wait on me (no question of theirs is in `waiting`): the task, and the handle of its assignee, who waits ("" for none). */
  tasks?: SummaryList<{ key: string; title: string; who: string; path: string }>;
  /**
   * Runs of agents I answer for that failed or did not start, which nothing
   * newer on their task replaced, in the last day: the task, and the run's
   * own reason line ("Not started: … ").
   */
  runs?: SummaryList<{ key: string; title: string; line: string; path: string }>;
  /**
   * Runs open now: waiting, working, or done and waiting for an answer; the
   * agent's handle, the task, the state's word, when it started (ms), and
   * Stop where I may stop it.
   */
  working?: SummaryList<{
    agent: string;
    key: string;
    title: string;
    state: string;
    since: number;
    path: string;
    stop?: DesktopAction;
  }>;
}

/** At most 10 of something, newest or most pressing first, and how many more there are. */
export interface SummaryList<T> {
  items: T[];
  more: number;
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
  | { kind: "samples"; agent?: string }
  /**
   * A connect code for the agent `agent` (a member id) in the tool `tool`
   * (its name, "Codex"), desktop contract §11: the outcome's `id` and
   * `code`. A new code for the same agent and tool replaces the open one.
   */
  | { kind: "connect-code"; agent: string; tool: string }
  /**
   * What the server says of the agent `agent` (a member id): the outcome's
   * `connected`, `listening`, and, of the code whose id is `code`,
   * `codeUsed` (it was given back) and `codeGone` (it no longer exists, or
   * ran out unused); and what listens as it: `listeners`, `pushed`,
   * `unheard` (a page of an older server says nothing of them).
   */
  | { kind: "agent-state"; agent: string; code?: string };

export type DesktopOutcome =
  | {
      ok: true;
      path?: string;
      agent?: { id: string; handle: string; name: string };
      token?: { id: string; secret: string };
      /** A connect code (connect-code): its id, and the code itself, shown once (isConnectCode). */
      id?: string;
      code?: string;
      /** An agent's state (agent-state). */
      connected?: boolean;
      listening?: boolean;
      codeUsed?: boolean;
      codeGone?: boolean;
      /**
       * What listens as the agent (agent-state): each live listener, of a
       * project (its key, a project key, and its name, shown as text only)
       * or, without one, of everything else, and
       * what holds it in its own words ("a chat"); whether a webhook pushes
       * to it; the projects (keys) nothing hears now.
       */
      listeners?: HeardListener[];
      pushed?: boolean;
      unheard?: string[];
      /**
       * The person who answers for the agent (agent-state): their handle,
       * without "@", and whether they are the person signed in in the page
       * that answers; absent when the agent has none, or the page cannot tell.
       */
      owner?: { handle: string; me: boolean };
    }
  | { ok: false; message: string; path?: string };

/** A live listener of an agent, as a page tells the app (DesktopOutcome's listeners). */
export interface HeardListener {
  project?: { key: string; name: string };
  by?: string;
  /** Quadit's runner holds it now (agent-runs-contract.md §3.2): Quadit runs the agent for that project on a computer. */
  runner?: boolean;
  /** With `runner`: that computer's name, as its runner says it (shown as text only). */
  machine?: string;
}

export interface QuaditDesktop {
  /** App version, e.g. "0.1.0". */
  version: string;
  /** Show a native notification; clicking it focuses the window and navigates to `path`. */
  notify(n: DesktopNotification): void;
  /**
   * Kept for the pages that call it, and does nothing: the app's number (on
   * the menu-bar icon and the Dock) is what waits on the person, which it
   * reads from the summary (waitsOnYou), not the unread count.
   */
  setBadge(count: number, workspace?: string): void;
  /** Replaces this window's summary; null takes it back (signed out, shell gone). */
  publish(summary: DesktopSummary | null): void;
  /** The one handler for requests the person made in the app; gives the function that stops it. */
  onRequest(handler: (request: DesktopRequest) => Promise<DesktopOutcome>): () => void;
  /**
   * Opens the app's Connect agents page over this page's window, for its
   * server and workspace; with `focus`, at the tool that works as that agent
   * of the workspace, ready for what the person meant (ConnectFocus): the
   * person still does it there. Missing in an app that cannot connect tools
   * (one older than this, on Windows).
   */
  openConnect?(focus?: ConnectFocus): void;
  /**
   * The tools on this computer that work as agents of this page's own
   * server and workspace (LocalAgent). Present only where openConnect is.
   */
  localAgents?(): Promise<LocalAgent[]>;
}

/**
 * Where Connect agents opens when a page asks: at `agent` (a member's user
 * id); `intent`, what the person meant to do there: connect a tool as it,
 * run it by Quadit, or disconnect it; `program`, the tool that works as it
 * whose controls the page showed (a LocalAgent's), when two do here.
 */
export interface ConnectFocus {
  agent?: string;
  intent?: "connect" | "run" | "disconnect";
  program?: string;
}

/** A tool on this computer that works as an agent of a page's workspace, as the page is told of it. */
export interface LocalAgent {
  /** The agent's user id. */
  agent: string;
  /** The tool (the harness id: "claude", "codex", …), and its name ("Claude Code"). */
  program: string;
  programName: string;
  /** This computer's name as Quadit's runner reports it, or "". */
  computer: string;
  /** Whether Run by Quadit is offered for it here. */
  canRun: boolean;
  /** The ids of the projects Quadit runs it for on this computer. */
  runs: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTENTS: readonly string[] = ["connect", "run", "disconnect"] satisfies ConnectFocus["intent"][];

/**
 * What a page sent with openConnect, as a focus: an agent's id (a UUID), one
 * of the intents, and a program among `programs` (the app's tools; any other
 * is left out); null for anything else, and Connect agents then opens as it
 * does without one.
 */
export function focusOf(raw: unknown, programs: readonly string[] = []): ConnectFocus | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { agent, intent, program } = raw as Record<string, unknown>;
  if (typeof agent !== "string" || !UUID.test(agent)) return null;
  if (intent !== undefined && (typeof intent !== "string" || !INTENTS.includes(intent))) return null;
  return {
    agent,
    ...(intent === undefined ? {} : { intent: intent as ConnectFocus["intent"] }),
    ...(typeof program === "string" && programs.includes(program) ? { program } : {}),
  };
}

export const BRIDGE_NOTIFY = "bridge:notify";
/** Page to app: a summary, or null. */
export const BRIDGE_PUBLISH = "bridge:publish";
/** App to page: `{id, request}`. */
export const BRIDGE_REQUEST = "bridge:request";
/** Page to app: `{id, outcome}`. */
export const BRIDGE_OUTCOME = "bridge:outcome";
/** Page to app: whether the page has a request handler now. */
export const BRIDGE_LISTENING = "bridge:listening";
/** Page to app: open the Connect agents page over this window; its payload, a ConnectFocus or null (focusOf). */
export const BRIDGE_OPEN_CONNECT = "bridge:open-connect";
/** Page to app, answered: the LocalAgent list of the page's own server and workspace. */
export const BRIDGE_LOCAL_AGENTS = "bridge:local-agents";
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
/** The most of each list a summary carries (SummaryList), the rest counted. */
const LIST_MAX = 10;
const LABEL_MAX = 40;
const REQUEST_MAX = 500;
const PLACEHOLDER_MAX = 80;
const MESSAGE_MAX = 500;
const SECRET_MAX = 500;

/**
 * Whether `raw` is a connect code (desktop contract §11): six characters of
 * an alphabet without look-alikes (no 0 or O, no 1, I or L). Nothing else is
 * shown as one: the person pastes its line into their agent, so a page must
 * not be able to put words of its own there.
 */
export function isConnectCode(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-HJKMNP-Z2-9]{6}$/.test(raw);
}
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

/**
 * How many things in `summary` wait on the person: the questions asked of
 * them, the tasks that wait on them and the runs that need them, the rest
 * beyond each list counted too. A page from before these lists says only
 * its questions.
 */
export function waitsOnYou(summary: DesktopSummary): number {
  const { waiting, waitingMore = 0, tasks, runs } = summary;
  const all = (list: SummaryList<unknown> | undefined) => (list ? list.items.length + list.more : 0);
  return waiting.length + waitingMore + all(tasks) + all(runs);
}

/** A count a page gives: a whole number from 0 up to a ceiling; refused when it is not a number. */
function countOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw refused;
  return Math.min(Math.max(Math.floor(raw), 0), COUNT_MAX);
}

/** A time a page gives (ms since 1970); refused when it is not one. */
function timeOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw refused;
  return Math.floor(raw);
}

/** A short list a page gives (SummaryList): at most LIST_MAX items, each read by `item`, and how many more. */
function shortList<T>(raw: unknown, item: (raw: unknown) => T): SummaryList<T> {
  const { items, more } = record(raw);
  return { items: list(items, LIST_MAX, item), more: countOf(more) };
}

/** One of `values`, or refused. */
function oneOf<T extends string>(raw: unknown, values: readonly T[]): T {
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) throw refused;
  return raw as T;
}

const TONES = ["ok", "work", "wait", "quiet"] as const;
const REACHES = ["not_connected", "not_listening", "heard"] as const;

/** `raw` as a summary the app keeps, as fresh plain data, or null when it is none. */
export function summaryOf(raw: unknown): DesktopSummary | null {
  return kept(() => {
    const { workspace, me, waiting, waitingMore, tasks, runs, working, agents, projects } = record(raw);
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
          ...defined({
            line: optional(agent.line, (v) => {
              const line = record(v);
              return { text: shown(line.text, BODY_MAX), tone: oneOf(line.tone, TONES) };
            }),
            reach: optional(agent.reach, (v) => oneOf(v, REACHES)),
          }),
        };
      }),
      projects: list(projects, PROJECTS_MAX, (v) => {
        const project = record(v);
        return { key: exact(project.key, ID_MAX), name: shown(project.name, TITLE_MAX) };
      }),
      ...defined({
        waitingMore: optional(waitingMore, countOf),
        tasks: optional(tasks, (v) =>
          shortList(v, (i) => {
            const task = record(i);
            return {
              key: exact(task.key, ID_MAX),
              title: shown(task.title, TITLE_MAX),
              who: shown(task.who, LABEL_MAX),
              path: exact(task.path, PATH_MAX),
            };
          }),
        ),
        runs: optional(runs, (v) =>
          shortList(v, (i) => {
            const run = record(i);
            return {
              key: exact(run.key, ID_MAX),
              title: shown(run.title, TITLE_MAX),
              line: shown(run.line, BODY_MAX),
              path: exact(run.path, PATH_MAX),
            };
          }),
        ),
        working: optional(working, (v) =>
          shortList(v, (i) => {
            const run = record(i);
            return defined({
              agent: shown(run.agent, LABEL_MAX),
              key: exact(run.key, ID_MAX),
              title: shown(run.title, TITLE_MAX),
              state: shown(run.state, LABEL_MAX),
              since: timeOf(run.since),
              path: exact(run.path, PATH_MAX),
              stop: optional(run.stop, actionOf),
            });
          }),
        ),
      }),
    };
  });
}

/**
 * A project key, as the server makes them (2 to 10 upper-case letters or
 * digits, starting with a letter): the only text of a page's that goes into
 * a line the person is told to write in their agent ("listen to Quadit for
 * SVA"), so a page cannot put words of its own there.
 */
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

/** A member's handle, without "@", as the server makes them: it goes into the words that say whose words start a run. */
const HANDLE = /^[a-z0-9_-]{2,32}$/;

/** A computer's name, as Quadit's runner says it (at most 64 characters): refused with a control character in it. */
function machineName(raw: unknown): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what is refused here.
  if (typeof raw !== "string" || raw.length > 64 || /[\u0000-\u001f\u007f]/.test(raw)) throw refused;
  return raw;
}

/** Whether `raw` is a project key as the server makes them (PROJECT_KEY); the app's own checks use it too. */
export function isProjectKey(raw: unknown): raw is string {
  return typeof raw === "string" && PROJECT_KEY.test(raw);
}

function projectKey(raw: unknown): string {
  if (!isProjectKey(raw)) throw refused;
  return raw;
}

/** `raw` as a page's answer to a request, as fresh plain data, or null when it is none. */
export function outcomeOf(raw: unknown): DesktopOutcome | null {
  return kept((): DesktopOutcome => {
    const {
      ok,
      path,
      message,
      agent,
      token,
      id,
      code,
      connected,
      listening,
      codeUsed,
      codeGone,
      listeners,
      pushed,
      unheard,
      owner,
    } = record(raw);
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
      id: optional(id, (v) => exact(v, ID_MAX)),
      code: optional(code, (v) => {
        if (!isConnectCode(v)) throw refused;
        return v;
      }),
      connected: optional(connected, flag),
      listening: optional(listening, flag),
      codeUsed: optional(codeUsed, flag),
      codeGone: optional(codeGone, flag),
      // One for everything else, and at most one for each project.
      listeners: optional(listeners, (v) =>
        list(v, PROJECTS_MAX + 1, (item): HeardListener => {
          const l = record(item);
          return defined({
            project: optional(l.project, (p) => {
              const project = record(p);
              return { key: projectKey(project.key), name: shown(project.name, TITLE_MAX) };
            }),
            by: optional(l.by, (b) => shown(b, LABEL_MAX)),
            runner: optional(l.runner, flag),
            machine: optional(l.machine, machineName),
          });
        }),
      ),
      pushed: optional(pushed, flag),
      unheard: optional(unheard, (v) => list(v, PROJECTS_MAX, projectKey)),
      owner: optional(owner, (v) => {
        const o = record(v);
        if (typeof o.handle !== "string" || !HANDLE.test(o.handle)) throw refused;
        return { handle: o.handle, me: flag(o.me) };
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
