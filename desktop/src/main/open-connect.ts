// A server's page asking the app to lay Connect agents over its window (the
// bridge's openConnect, desktop contract §8 and §11: the web app's "Connect
// a tool on this computer", and an agent card's actions, with a focus on
// that agent). Only a server's own page may ask (server-windows.ts checks
// the sender), what it sends is taken only as a focus (focusOf), and the
// app answers at most once a second however often it is asked: a page
// cannot keep the app busy.

import { type ConnectFocus, focusOf } from "@/shared/bridge";

const ASK_EVERY_MS = 1_000;

export class OpenConnect {
  private last = Number.NEGATIVE_INFINITY;

  /** `open` lays Connect agents over a server's window (or brings it to the front), at `focus`; `now` is the time in ms. */
  constructor(
    private open: (serverId: string, focus: ConnectFocus | null) => void,
    private now: () => number = Date.now,
  ) {}

  /**
   * A page asked, sending `raw` (a focus, or anything); `serverId` is the
   * server whose own page it is, or null when the sender is not one, which
   * is ignored.
   */
  asked(serverId: string | null, raw: unknown = null) {
    if (serverId === null) return;
    const now = this.now();
    if (now - this.last < ASK_EVERY_MS) return;
    this.last = now;
    this.open(serverId, focusOf(raw));
  }
}
