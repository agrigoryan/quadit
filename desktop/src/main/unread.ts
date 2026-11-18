// Unread counts: each window of a server reports the count of the workspace
// it shows, through the bridge, and the app shows the sum on the dock icon
// (the taskbar where the system has a badge) and beside the menu-bar icon,
// whose menu opens a server. A server's count is the sum of its workspaces,
// each counted once however many windows show it: a workspace's count is the
// newest report of it, 0 included. A window shows one workspace at a time,
// so what it reported goes when it reports another, reports none, or its
// page goes away; another window's report of the same workspace then counts.

import { app, Menu, nativeImage, Tray } from "electron";
import type { ServerStore } from "@/main/servers";

export interface UnreadSetup {
  /** The menu-bar icon: a template image file (black on transparent). */
  trayIcon: string;
  openServer(serverId: string): void;
  showServerList(): void;
}

export class Unread {
  /** Each reporter's (a web contents, by id) last report, oldest first: a newer report of a workspace outweighs an older one. */
  private reports = new Map<number, { serverId: string; workspace: string; count: number }>();
  private tray: Tray | undefined;

  constructor(
    private store: ServerStore,
    private setup: UnreadSetup,
  ) {
    store.onChange(() => {
      for (const [reporter, { serverId }] of this.reports) if (!store.get(serverId)) this.reports.delete(reporter);
      this.render();
    });
  }

  /** Puts the menu-bar icon up; call once the app is ready. */
  start() {
    const icon = nativeImage.createFromPath(this.setup.trayIcon);
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip(app.name);
    this.render();
  }

  /**
   * `reporter` shows `workspace` of the server, which has `count` unread now
   * (0 is a count like any other). An empty `workspace` is none: what the
   * reporter said before is taken back.
   */
  report(serverId: string, reporter: number, workspace: string, count: number) {
    this.reports.delete(reporter);
    if (workspace) this.reports.set(reporter, { serverId, workspace, count });
    this.render();
  }

  /** Takes back what `reporter` said: its page went away. */
  forget(reporter: number) {
    if (this.reports.delete(reporter)) this.render();
  }

  /** A server's count: each workspace's newest report, added up. */
  of(serverId: string): number {
    const workspaces = new Map<string, number>();
    for (const report of this.reports.values()) {
      if (report.serverId === serverId) workspaces.set(report.workspace, report.count);
    }
    let sum = 0;
    for (const count of workspaces.values()) sum += count;
    return sum;
  }

  get total(): number {
    let sum = 0;
    for (const server of this.store.list()) sum += this.of(server.id);
    return sum;
  }

  private render() {
    const total = this.total;
    app.setBadgeCount(total);
    if (!this.tray) return;
    this.tray.setTitle(total > 0 ? String(total) : "");
    this.tray.setToolTip(total > 0 ? `${app.name}: ${total} unread` : app.name);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...this.store.list().map((server) => {
          const count = this.of(server.id);
          return {
            label: count > 0 ? `${server.name} (${count})` : server.name,
            click: () => this.setup.openServer(server.id),
          };
        }),
        { type: "separator" },
        { label: "Servers…", click: () => this.setup.showServerList() },
        { type: "separator" },
        { label: `Quit ${app.name}`, role: "quit" },
      ]),
    );
  }
}
