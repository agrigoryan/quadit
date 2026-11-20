// How often the app signs a server's window in by itself, without a form
// (desktop contract §7; for the server on this computer, through its app
// key: local-server.ts, signInOwner). Server windows ask before a load and
// whenever the window lands on the sign-in page (server-windows.ts).
//
// Once, until the window has shown a workspace since: a server that keeps
// sending the window back to its sign-in page, or answers that it cannot,
// gets one try and then the sign-in page stays, instead of a loop. A
// sign-in page after a workspace (the session ran out, or the person signed
// out) is a new case and gets its try.

export class AppSignIn {
  /** The servers tried since their window last showed a workspace. */
  private tried = new Set<string>();

  /** `signIn` signs a server's window in when it can, and says whether it did just now. */
  constructor(private signIn: (serverId: string) => Promise<boolean>) {}

  /** Signs the server's window in, unless that was tried since it last showed a workspace; true when it did just now. */
  attempt(serverId: string): Promise<boolean> {
    if (this.tried.has(serverId)) return Promise.resolve(false);
    this.tried.add(serverId);
    return this.signIn(serverId);
  }

  /** The server's window showed a workspace: it was signed in. */
  showedWorkspace(serverId: string) {
    this.tried.delete(serverId);
  }
}
