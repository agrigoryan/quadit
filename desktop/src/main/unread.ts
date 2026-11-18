// Unread counts: each window of a server reports the count of the workspace
// it shows, through the bridge, and the app shows the sum on the dock icon
// (the taskbar where the system has a badge) and beside the menu-bar icon,
// whose menu opens a server. A server's count is the sum of its workspaces,
// each counted once however many windows show it; a window that leaves a
// workspace or closes takes off only what it reported.

import { app, Menu, nativeImage, Tray } from "electron";
import type { ServerStore } from "@/main/servers";

export interface UnreadSetup {
  /** The menu-bar icon: a template image file (black on transparent). */
  trayIcon: string;
  openServer(serverId: string): void;
  showServerList(): void;
}

export class Unread {
  /**
   * Per server, per workspace, what each reporter (a web contents, by id)
   * said, in the order said: the last is the newest, and the workspace's count.
   */
  private counts = new Map<string, Map<string, Map<number, number>>>();
  private tray: Tray | undefined;

  constructor(
    private store: ServerStore,
    private setup: UnreadSetup,
  ) {
    store.onChange(() => {
      for (const id of this.counts.keys()) if (!store.get(id)) this.counts.delete(id);
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

  /** What `reporter` says `workspace` of the server has unread now; 0 takes its word back. */
  report(serverId: string, reporter: number, workspace: string, count: number) {
    let workspaces = this.counts.get(serverId);
    if (!workspaces) this.counts.set(serverId, (workspaces = new Map()));
    let reporters = workspaces.get(workspace);
    if (!reporters) workspaces.set(workspace, (reporters = new Map()));
    reporters.delete(reporter);
    if (count > 0) reporters.set(reporter, count);
    if (reporters.size === 0) workspaces.delete(workspace);
    this.render();
  }

  /** Takes back everything `reporter` said: its page went away. */
  forget(reporter: number) {
    let changed = false;
    for (const workspaces of this.counts.values()) {
      for (const [workspace, reporters] of workspaces) {
        changed = reporters.delete(reporter) || changed;
        if (reporters.size === 0) workspaces.delete(workspace);
      }
    }
    if (changed) this.render();
  }

  /** A server's count: each workspace's newest report, added up. */
  of(serverId: string): number {
    let sum = 0;
    for (const reporters of this.counts.get(serverId)?.values() ?? []) sum += [...reporters.values()].at(-1) ?? 0;
    return sum;
  }

  get total(): number {
    let sum = 0;
    for (const serverId of this.counts.keys()) sum += this.of(serverId);
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
