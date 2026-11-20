// How often the app signs a server's window in by itself, without a form
// (desktop contract §7; for the server on this computer, through its app
// key: local-server.ts, signInOwner). Server windows ask before a load and
// whenever the window lands on the sign-in page (server-windows.ts), and
// a sign-in that worked sends the window on to its page.
//
// After a sign-in that worked, not again until the window has shown a
// workspace: a server that says yes but keeps sending the window back to
// its sign-in page gets no loop of sign-ins and loads, and its sign-in page
// stays. A sign-in page after a workspace (the session ran out, or the
// person signed out) is a new case. One that did not sign in (signed in
// already, or a server that cannot) moves nothing, so it may be asked again
// at the next load.

export class AppSignIn {
  /** The servers signed in since their window last showed a workspace. */
  private signedIn = new Set<string>();

  /** `signIn` signs a server's window in when it can, and says whether it did just now. */
  constructor(private signIn: (serverId: string) => Promise<boolean>) {}

  /** Signs the server's window in, unless it was since it last showed a workspace; true when it did just now. */
  async attempt(serverId: string): Promise<boolean> {
    if (this.signedIn.has(serverId)) return false;
    const now = await this.signIn(serverId);
    if (now) this.signedIn.add(serverId);
    return now;
  }

  /** The server's window showed a workspace: the sign-in worked. */
  showedWorkspace(serverId: string) {
    this.signedIn.delete(serverId);
  }
}
