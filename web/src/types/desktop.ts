// What the Quadit desktop app gives the pages of a server it opens: its
// preload script sets window.quaditDesktop on the server's own origin, and
// nowhere else. In a browser it is not there.

export interface QuaditDesktop {
  /** The app's version, e.g. "0.1.0". */
  version: string;
  /** Shows a native notification; clicking it focuses the window and opens `path` (on this server, starting with "/"). */
  notify(n: { title: string; body: string; path: string; tag?: string }): void;
  /** The unread count for this server (0 clears it); the app adds the servers up for its dock and tray badge. */
  setBadge(count: number): void;
}

declare global {
  interface Window {
    quaditDesktop?: QuaditDesktop;
  }
}
