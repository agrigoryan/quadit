// A server's page asking the app to open its Connect agents window (the
// bridge's openConnect, desktop contract §8: the web app's "Connect a tool
// on this computer"). Only a server's own page may ask (server-windows.ts
// checks the sender), and the app opens its own window at most once a
// second however often it is asked: a page cannot flood the screen.

const ASK_EVERY_MS = 1_000;

export class OpenConnect {
  private last = Number.NEGATIVE_INFINITY;

  /** `open` opens (or focuses) the Connect window for a server; `now` is the time in ms. */
  constructor(
    private open: (serverId: string) => void,
    private now: () => number = Date.now,
  ) {}

  /** A page asked; `serverId` is the server whose own page it is, or null when the sender is not one, which is ignored. */
  asked(serverId: string | null) {
    if (serverId === null) return;
    const now = this.now();
    if (now - this.last < ASK_EVERY_MS) return;
    this.last = now;
    this.open(serverId);
  }
}
