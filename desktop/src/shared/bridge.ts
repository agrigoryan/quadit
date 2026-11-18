// The desktop bridge as the contract fixes it (section 3), and the IPC
// channels the preload uses to carry it to the main process.

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

/** The command-line switches through which a server window's preload learns its server's origin and the app version. */
export const ORIGIN_SWITCH = "--quadit-origin=";
export const VERSION_SWITCH = "--quadit-version=";

declare global {
  interface Window {
    quaditDesktop?: QuaditDesktop;
  }
}
