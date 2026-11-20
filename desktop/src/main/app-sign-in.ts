// How the app signs a server's window in by itself, without a form
// (desktop contract §7; for the server on this computer, through its app
// key: local-server.ts, signInOwner). Server windows ask before a load and
// when the window lands on the sign-in page (server-windows.ts).
//
//   - One sign-in at a time per server: a second caller waits for the
//     first's outcome instead of asking again.
//   - After a sign-in that worked, none again until a navigation of the
//     window outside the sign-in page has ended signed in (a workspace, the
//     admin pages: asked of the server), or the server has started anew. A
//     server that says yes but keeps sending the window back to its
//     sign-in page so gets no loop of sign-ins and loads; a sign-in page
//     after the window was seen signed in (the session ran out, or the
//     person signed out) is a new case.
//   - One that did not sign in (signed in already, or a server that
//     cannot) sends the window nowhere, so it may be asked again.

export interface AppSignInParts {
  /** Signs the server's window in when the app can; true when it did just now. */
  signIn(serverId: string): Promise<boolean>;
  /** Whether the server's window is signed in now. */
  isSignedIn(serverId: string): Promise<boolean>;
}

export class AppSignIn {
  /** The servers signed in by the app since their window was last seen signed in on a page of its own. */
  private held = new Set<string>();
  private inFlightFor = new Map<string, Promise<boolean>>();
  /** The servers whose session is being checked after a navigation. */
  private checking = new Set<string>();

  constructor(private parts: AppSignInParts) {}

  /** Signs the server's window in, unless that is held back; true when it did just now. Joins one under way. */
  attempt(serverId: string): Promise<boolean> {
    const going = this.inFlightFor.get(serverId);
    if (going) return going;
    if (this.held.has(serverId)) return Promise.resolve(false);
    const signing = this.parts
      .signIn(serverId)
      .then((now) => {
        if (now) this.held.add(serverId);
        return now;
      })
      .finally(() => this.inFlightFor.delete(serverId));
    this.inFlightFor.set(serverId, signing);
    return signing;
  }

  /** Whether a sign-in of the server's window is under way. */
  inFlight(serverId: string): boolean {
    return this.inFlightFor.has(serverId);
  }

  /** The server's window navigated, to its sign-in page or not; outside it, a window found signed in lets go of the hold. */
  navigated(serverId: string, toSignInPage: boolean) {
    if (toSignInPage || !this.held.has(serverId) || this.checking.has(serverId)) return;
    this.checking.add(serverId);
    void this.parts
      .isSignedIn(serverId)
      .then((signedIn) => {
        if (signedIn) this.held.delete(serverId);
      })
      .finally(() => this.checking.delete(serverId));
  }

  /** The server started anew: what was held back for its window no longer holds. */
  serverStarted(serverId: string) {
    this.held.delete(serverId);
  }
}
