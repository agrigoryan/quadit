// How the app signs a server's window in by itself, without a form
// (desktop contract §7; for the server on this computer, through its app
// key: local-server.ts, signInOwner). Server windows ask before a load and
// when the window lands on the sign-in page (server-windows.ts).
//
//   - One sign-in at a time per server: a second caller waits for the
//     first's outcome instead of asking again.
//   - After a sign-in, only the newest sign-in page goes on to where it is
//     headed, and only when no navigation of the window has started since
//     it landed: the web app sends a page that finds itself signed out to
//     the sign-in page by itself, and a link may come while that sign-in
//     runs; going on from the older page would load over the newer one, or
//     cancel a navigation started and not shown yet. A page that started
//     loading after the sign-in finds the session there, and the web app's
//     sign-in page goes on to its own next by itself.
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
  /** For each server's window: how many times it landed on its sign-in page, and started a navigation. */
  private counts = new Map<string, { landings: number; started: number }>();

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

  /**
   * The server's window landed on its sign-in page: signs it in (or waits
   * for the sign-in under way). True when the window is to go on from this
   * page to where it is headed: it was signed in just now, and since this
   * landing no other sign-in page landed and no navigation started.
   */
  async fromSignInPage(serverId: string): Promise<boolean> {
    const counts = this.countsOf(serverId);
    const landing = ++counts.landings;
    const started = counts.started;
    const signedIn = await this.attempt(serverId);
    return signedIn && counts.landings === landing && counts.started === started;
  }

  /** A navigation of the server's window to another document started (not one within the page). */
  navigationStarted(serverId: string) {
    this.countsOf(serverId).started++;
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

  private countsOf(serverId: string) {
    let counts = this.counts.get(serverId);
    if (!counts) {
      counts = { landings: 0, started: 0 };
      this.counts.set(serverId, counts);
    }
    return counts;
  }

  /** The server started anew: what was held back for its window no longer holds. */
  serverStarted(serverId: string) {
    this.held.delete(serverId);
  }
}
