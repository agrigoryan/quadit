// What the app's own bundled pages (the server list and the sign-in bar)
// may ask of the app, through the preload src/preload/pages.ts. The server's
// web pages never see this: they get only the bridge of the contract.

export interface ServerView {
  id: string;
  name: string;
  origin: string;
}

/** How a server answered just now; see src/main/probe.ts for what each fit means. */
export type ServerStatus =
  { reachable: true; version: string; fit: "ok" | "old-server" | "new-server" } | { reachable: false; reason: string };

export type AddResult = { ok: true; server: ServerView } | { ok: false; error: string };

/** A quadit://open link named a server that is not added yet: the server list offers to add it. */
export interface Invitation {
  origin: string;
}

export interface PagesApi {
  listServers(): Promise<ServerView[]>;
  checkServer(id: string): Promise<ServerStatus>;
  addServer(address: string, name: string): Promise<AddResult>;
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
}

/** The IPC channels of this API: "pages:" and the method's name, and the one the app sends changes on. */
export const PAGES_CHANNEL = "pages:";
export const PAGES_CHANGED = "pages:changed";

declare global {
  interface Window {
    quaditPages?: PagesApi;
  }
}
