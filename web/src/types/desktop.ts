// What the Quadit desktop app gives the pages of a server it opens: its
// preload script sets window.quaditDesktop on the server's own origin, and
// nowhere else. In a browser it is not there. The app's own copy of these
// shapes is desktop/src/shared/bridge.ts; the two are kept the same.

/** A button the page defines; the app hands `request` back unchanged when the person presses it. */
export interface DesktopAction {
  /** At most 40 characters. */
  label: string;
  /** At most 500 characters; what it means is the page's (shell/desktop-requests.ts), the app only hands it back. */
  request: string;
}

export interface DesktopNotification {
  title: string;
  body: string;
  /** Where clicking it goes: a page of the web app on this server. */
  path: string;
  /** A notification with the tag of an earlier one replaces it. */
  tag?: string;
  /** The inbox item's id: the app shows each once, whichever of its windows tells it. */
  id?: string;
  /** At most 3; shown on macOS only. */
  actions?: DesktopAction[];
  /** A reply box (macOS only); the text comes back with `request`. */
  reply?: { placeholder: string; request: string };
}

/** What this window's workspace looks like to the app's own windows (the panel, quick capture, Connect). */
export interface DesktopSummary {
  workspace: { id: string; slug: string; name: string };
  me: { name: string; canCreateAgents: boolean };
  /** Decisions waiting on me, newest first, at most 20, each with at most 6 actions. */
  waiting: { title: string; detail: string; path: string; actions: DesktopAction[] }[];
  /** Agents in the workspace, at most 50; `usable`: I may let a client work as it (I answer for it, or I am an admin). */
  agents: {
    id: string;
    handle: string;
    name: string;
    state: "working" | "waiting" | "has_work" | "idle";
    detail: string;
    path: string;
    usable: boolean;
  }[];
  /** Projects I may create tasks in, at most 200, for quick capture. */
  projects: { key: string; name: string }[];
}

/** Something the person asked for in the app, which the page carries out through its own write paths. */
export type DesktopRequest =
  /** A notification's or the panel's button, with the reply's text (at most 10000 characters) for a reply. */
  | { kind: "action"; request: string; text?: string }
  /** Quick capture; `project` null is allowed only for a page. */
  | { kind: "capture"; project: string | null; what: "task" | "page"; title: string; body: string }
  /** Makes a standing agent. */
  | { kind: "agent"; create: { name: string; handle: string } }
  /** Makes a token for an agent (by user id), named `label`, that does not expire. */
  | { kind: "agent-token"; agent: string; label: string }
  /** Revokes a token, by its id. */
  | { kind: "revoke-token"; token: string };

/** How a request went: what it made, or the server's refusal (at most 500 characters). */
export type DesktopOutcome =
  | {
      ok: true;
      path?: string;
      agent?: { id: string; handle: string; name: string };
      token?: { id: string; secret: string };
    }
  | { ok: false; message: string; path?: string };

export interface QuaditDesktop {
  /** The app's version, e.g. "0.1.0". */
  version: string;
  /**
   * Shows a native notification; clicking it focuses the window and opens
   * `path` (a page of the web app on this server). `id` is the inbox item's:
   * the app shows each once, whichever of its windows tells it.
   */
  notify(n: DesktopNotification): void;
  /**
   * The unread count of `workspace` (its id), the one this window shows; 0
   * is a count like any other. Without a workspace, the window shows none
   * and its count is taken off. The app counts each workspace once (its
   * newest report), and adds up the servers, for its dock and tray badge.
   */
  setBadge(count: number, workspace?: string): void;
  // The app is released apart from the server: an app older than these two has neither, and gets no summary and no requests.
  /** Replaces this window's summary; null takes it back (signed out, the shell gone). */
  publish?(summary: DesktopSummary | null): void;
  /** The one handler for requests the person made in the app; returns a function that stops it. */
  onRequest?(handler: (r: DesktopRequest) => Promise<DesktopOutcome>): () => void;
}

declare global {
  interface Window {
    quaditDesktop?: QuaditDesktop;
  }
}
