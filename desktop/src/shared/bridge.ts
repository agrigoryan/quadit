// The desktop bridge as the contract fixes it (section 3), the IPC channels
// the preload uses to carry it to the main process, and the shape a message
// must have to be kept. Both sides hold a message to that shape: the preload
// so that a page cannot make the app copy megabytes across, the main process
// because the preload is the page's process and cannot be trusted.

export interface DesktopNotification {
  title: string;
  body: string;
  /** Where clicking it goes: a path on the same server, starting with "/". */
  path: string;
  /** A notification with the tag of an earlier one replaces it. */
  tag?: string;
  /** The inbox item's id: the app shows each once, whichever of a server's windows tells it. */
  id?: string;
}

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
}

export const BRIDGE_NOTIFY = "bridge:notify";
export const BRIDGE_BADGE = "bridge:badge";

const TITLE_MAX = 200;
const BODY_MAX = 1000;
const PATH_MAX = 2048;
const TAG_MAX = 200;
const ID_MAX = 200;
const WORKSPACE_MAX = 200;
const COUNT_MAX = 99_999;

/**
 * `raw` as a notification the app keeps, or null when it is none: strings
 * only, nothing coerced. A long title or body is cut short; a path, tag or
 * id that is too long refuses the whole notification, since cut short it
 * would name another page, or replace another notification.
 */
export function notificationOf(raw: unknown): DesktopNotification | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { title, body, path, tag, id } = raw as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string" || typeof path !== "string") return null;
  if (path.length > PATH_MAX) return null;
  if (tag !== undefined && (typeof tag !== "string" || tag.length > TAG_MAX)) return null;
  if (id !== undefined && (typeof id !== "string" || id.length > ID_MAX)) return null;
  return {
    title: title.slice(0, TITLE_MAX),
    body: body.slice(0, BODY_MAX),
    path,
    ...(tag !== undefined ? { tag } : {}),
    ...(id !== undefined ? { id } : {}),
  };
}

/** `raw` as a badge report the app keeps (a whole count, from 0 up to a ceiling; "" for no workspace), or null when it is none. */
export function badgeOf(raw: unknown): { count: number; workspace: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { count, workspace } = raw as Record<string, unknown>;
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  if (typeof workspace !== "string" || workspace.length > WORKSPACE_MAX) return null;
  return { count: Math.min(Math.max(Math.floor(count), 0), COUNT_MAX), workspace };
}

/** The command-line switches through which a server window's preload learns its server's origin and the app version. */
export const ORIGIN_SWITCH = "--quadit-origin=";
export const VERSION_SWITCH = "--quadit-version=";

declare global {
  interface Window {
    quaditDesktop?: QuaditDesktop;
  }
}
