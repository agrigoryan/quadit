// What a server's page may show as a native notification. A page is the
// server's, and a server may be hostile or have a hole in it, so what it
// sends over the bridge is held to a shape here, in the main process,
// whatever the preload did: plain strings of bounded size (notificationOf),
// an inbox item shown once however many of the server's windows tell it
// (each that leads its own workspace's stream does, and where Web Locks are
// missing, as on plain http, every window leads), and no more than a
// handful a minute.

import { type DesktopNotification, notificationOf } from "@/shared/bridge";

/** Inbox item ids remembered per server: far more than arrive while a person is away. */
const IDS_KEPT = 1000;
/** At most this many notifications from a server in any minute; the rest are dropped (the badge still counts them). */
const PER_MINUTE = 10;
const MINUTE_MS = 60_000;

export class NoticeGate {
  /** Per server: the ids shown, oldest first, and when its last notifications were shown. */
  private servers = new Map<string, { ids: Set<string>; shownAt: number[] }>();

  /** The notification to show for what `serverId`'s page sent at `now`, or null when it is not to be shown. */
  admit(serverId: string, raw: unknown, now: number): DesktopNotification | null {
    const n = notificationOf(raw);
    if (!n) return null;
    let server = this.servers.get(serverId);
    if (!server) this.servers.set(serverId, (server = { ids: new Set(), shownAt: [] }));
    if (n.id !== undefined && server.ids.has(n.id)) return null;
    server.shownAt = server.shownAt.filter((at) => now - at < MINUTE_MS);
    if (server.shownAt.length >= PER_MINUTE) return null;
    server.shownAt.push(now);
    if (n.id !== undefined) {
      server.ids.add(n.id);
      if (server.ids.size > IDS_KEPT) server.ids.delete(server.ids.values().next().value ?? "");
    }
    return n;
  }

  /** Forgets a removed server. */
  forget(serverId: string) {
    this.servers.delete(serverId);
  }
}
