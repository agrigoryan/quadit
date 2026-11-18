// Unread counts: each server's page reports its own through the bridge, and
// the app shows their sum on the dock icon (the taskbar where the system
// has a badge) and beside the menu-bar icon, whose menu opens a server.

import { app, Menu, nativeImage, Tray } from "electron";
import type { ServerStore } from "@/main/servers";

export interface UnreadSetup {
  /** The menu-bar icon: a template image file (black on transparent). */
  trayIcon: string;
  openServer(serverId: string): void;
  showServerList(): void;
}

export class Unread {
  private counts = new Map<string, number>();
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

  /** Records a server's count (0 clears it) and shows the new total. */
  set(serverId: string, count: number) {
    if ((this.counts.get(serverId) ?? 0) === count) return;
    if (count > 0) this.counts.set(serverId, count);
    else this.counts.delete(serverId);
    this.render();
  }

  get total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
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
          const count = this.counts.get(server.id) ?? 0;
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
