// The menu-bar icon and its number: what waits on the person in the
// workspaces the app's windows show (the questions asked of them, the tasks
// that wait on them, the runs that need them: waitsOnYou), read from what
// each window's page publishes (requests.ts). The number stands beside the
// icon and on the Dock (the taskbar where the system has a badge); nothing
// waits, no number. Unread inbox items are not counted: they stay in the
// web app. Each workspace counts once, at its newest summary.
//
// Clicking the icon opens the panel (panel.ts); its menu of servers, each
// with its own number, is on the right click. Linux trays only have a menu,
// so there the panel is the menu's first item.

import { app, Menu, nativeImage, type Rectangle, Tray } from "electron";
import { PANEL_LABEL } from "@/main/menu";
import type { ServerStore } from "@/main/servers";
import { type DesktopSummary, waitsOnYou } from "@/shared/bridge";

export interface MenuBarSetup {
  /** The menu-bar icon: a template image file (black on transparent). */
  trayIcon: string;
  openServer(serverId: string): void;
  showServerList(): void;
  /** Opens or closes the panel, under the icon at `tray` when its place is known. */
  togglePanel(tray: Rectangle | null): void;
  /** The workspaces the windows show, each once, as their pages published them (Requests.summaries). */
  summaries(): { serverId: string; summary: DesktopSummary }[];
}

export class MenuBar {
  private tray: Tray | undefined;
  private menu: Menu | undefined;

  constructor(
    private store: ServerStore,
    private setup: MenuBarSetup,
  ) {
    store.onChange(() => this.changed());
  }

  /** Puts the menu-bar icon up; call once the app is ready. */
  start() {
    const icon = nativeImage.createFromPath(this.setup.trayIcon);
    icon.setTemplateImage(true);
    const tray = new Tray(icon);
    tray.setToolTip(app.name);
    tray.on("click", (_event, bounds) => this.setup.togglePanel(bounds));
    tray.on("right-click", () => this.menu && tray.popUpContextMenu(this.menu));
    this.tray = tray;
    this.changed();
  }

  /** Where the menu-bar icon is on screen, when the system says. */
  trayBounds(): Rectangle | null {
    return this.tray?.getBounds() ?? null;
  }

  /** How many things wait on the person in the server's workspaces that windows show. */
  of(serverId: string): number {
    let sum = 0;
    for (const shown of this.setup.summaries()) if (shown.serverId === serverId) sum += waitsOnYou(shown.summary);
    return sum;
  }

  /** How many things wait on the person, in every server the app has. */
  get total(): number {
    let sum = 0;
    for (const server of this.store.list()) sum += this.of(server.id);
    return sum;
  }

  /** What a page published, or the servers, changed: the number and the menu follow. */
  changed() {
    const total = this.total;
    app.setBadgeCount(total);
    if (!this.tray) return;
    this.tray.setTitle(total > 0 ? String(total) : "");
    this.tray.setToolTip(total > 0 ? `${app.name}: ${total} waiting on you` : app.name);
    const linux = process.platform === "linux";
    this.menu = Menu.buildFromTemplate([
      ...(linux
        ? [{ label: PANEL_LABEL, click: () => this.setup.togglePanel(null) }, { type: "separator" as const }]
        : []),
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
    ]);
    // Elsewhere a context menu would take the click from the panel.
    if (linux) this.tray.setContextMenu(this.menu);
  }
}
