// Unread counts: each window of a server reports the count of the workspace
// it shows, through the bridge, and the app shows the sum on the dock icon
// (the taskbar where the system has a badge) and beside the menu-bar icon,
// whose menu opens a server. A server's count is the sum of the workspaces
// its windows show, each counted once however many windows show it. A
// workspace's count is its newest report, 0 included, whichever window made
// it: a window that leaves takes nothing back while another window still
// shows that workspace, since an older report it held may be out of date. A
// window shows one workspace at a time, so it leaves one when it reports
// another, reports none, or its page goes away.
//
// Clicking the menu-bar icon opens the panel (panel.ts); its menu of servers
// is on the right click. Linux trays only have a menu, so there the panel is
// the menu's first item.

import { app, Menu, nativeImage, type Rectangle, Tray } from "electron";
import { PANEL_LABEL } from "@/main/menu";
import type { ServerStore } from "@/main/servers";

export interface UnreadSetup {
  /** The menu-bar icon: a template image file (black on transparent). */
  trayIcon: string;
  openServer(serverId: string): void;
  showServerList(): void;
  /** Opens or closes the panel, under the icon at `tray` when its place is known. */
  togglePanel(tray: Rectangle | null): void;
}

export class Unread {
  /** The workspace each reporter (a web contents, by id) shows. */
  private shown = new Map<number, Workspace>();
  /** The newest count of each shown workspace, by server and workspace. */
  private counts = new Map<string, Map<string, number>>();
  private tray: Tray | undefined;
  private menu: Menu | undefined;

  constructor(
    private store: ServerStore,
    private setup: UnreadSetup,
  ) {
    store.onChange(() => {
      for (const [reporter, { serverId }] of this.shown) if (!store.get(serverId)) this.leave(reporter);
      this.render();
    });
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
    this.render();
  }

  /** Where the menu-bar icon is on screen, when the system says. */
  trayBounds(): Rectangle | null {
    return this.tray?.getBounds() ?? null;
  }

  /**
   * `reporter` shows `workspace` of the server, which has `count` unread now
   * (0 is a count like any other). An empty `workspace` is none.
   */
  report(serverId: string, reporter: number, workspace: string, count: number) {
    this.leave(reporter);
    if (workspace) {
      this.shown.set(reporter, { serverId, workspace });
      const counts = this.counts.get(serverId) ?? new Map<string, number>();
      this.counts.set(serverId, counts.set(workspace, count));
    }
    this.render();
  }

  /** `reporter`'s page went away. */
  forget(reporter: number) {
    if (this.shown.has(reporter)) {
      this.leave(reporter);
      this.render();
    }
  }

  /** A server's count: the newest count of each workspace its windows show, added up. */
  of(serverId: string): number {
    let sum = 0;
    for (const count of this.counts.get(serverId)?.values() ?? []) sum += count;
    return sum;
  }

  get total(): number {
    let sum = 0;
    for (const server of this.store.list()) sum += this.of(server.id);
    return sum;
  }

  /** `reporter` no longer shows its workspace, whose count goes once no other window shows it. */
  private leave(reporter: number) {
    const left = this.shown.get(reporter);
    if (!left) return;
    this.shown.delete(reporter);
    for (const other of this.shown.values()) {
      if (other.serverId === left.serverId && other.workspace === left.workspace) return;
    }
    this.counts.get(left.serverId)?.delete(left.workspace);
  }

  private render() {
    const total = this.total;
    app.setBadgeCount(total);
    if (!this.tray) return;
    this.tray.setTitle(total > 0 ? String(total) : "");
    this.tray.setToolTip(total > 0 ? `${app.name}: ${total} unread` : app.name);
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

  /** The servers whose windows show a workspace now. */
  showing(): string[] {
    return [...this.counts].filter(([, workspaces]) => workspaces.size > 0).map(([serverId]) => serverId);
  }
}

interface Workspace {
  serverId: string;
  workspace: string;
}
