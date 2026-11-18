// What the Quadit desktop app gives the pages of a server it opens: its
// preload script sets window.quaditDesktop on the server's own origin, and
// nowhere else. In a browser it is not there.

export interface QuaditDesktop {
  /** The app's version, e.g. "0.1.0". */
  version: string;
  /**
   * Shows a native notification; clicking it focuses the window and opens
   * `path` (a page of the web app on this server). `id` is the inbox item's:
   * the app shows each once, whichever of its windows tells it.
   */
  notify(n: { title: string; body: string; path: string; tag?: string; id?: string }): void;
  /**
   * The unread count of `workspace` (its id) as this window sees it; 0 takes
   * this window's count off. The app adds up each workspace once, and the
   * servers, for its dock and tray badge.
   */
  setBadge(count: number, workspace?: string): void;
}

declare global {
  interface Window {
    quaditDesktop?: QuaditDesktop;
  }
}
