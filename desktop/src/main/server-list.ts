// The server list: the app's own bundled page where servers are added,
// checked, opened, signed in to and removed, and the IPC that answers the
// bundled pages (the list and the sign-in bar) through src/preload/pages.ts.
// Only frames loaded from the app's own page files are answered.

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { serverOrigin, transportOf } from "@/main/origins";
import { type Fetch, probe } from "@/main/probe";
import type { ServerChecks } from "@/main/server-checks";
import type { ServerWindows } from "@/main/server-windows";
import type { Server, ServerStore } from "@/main/servers";
import {
  type AddResult,
  type Invitation,
  PAGES_CHANGED,
  PAGES_CHANNEL,
  type PagesApi,
  type ServerStatus,
  type ServerView,
} from "@/shared/pages-api";

export interface ServerListSetup {
  pagesPreload: string;
  /** The file URL of the folder holding the bundled pages; frames from anywhere else are not answered. */
  pagesUrl: string;
  /** The network the probes of servers being added go through (Electron's net.fetch). */
  fetcher: Fetch;
  /** What asks added servers what they are and keeps the answer. */
  checks: ServerChecks;
  signIn(serverId: string): void;
}

/** The pages API as the main process answers it: the same methods, the asking frame's web contents first. */
type Handlers = {
  [K in keyof PagesApi]: (sender: Electron.WebContents, ...args: Parameters<PagesApi[K]>) => unknown;
};

export class ServerList {
  private win: BrowserWindow | undefined;
  private invitation: Invitation | null = null;
  /** The page a link asked for on a server not added yet: opened when that server is added. */
  private destination: { origin: string; path: string } | null = null;

  constructor(
    private store: ServerStore,
    private windows: ServerWindows,
    private setup: ServerListSetup,
  ) {
    const handlers: Omit<Handlers, "onChanged"> = {
      listServers: () => store.list().map(view),
      checkServer: (_sender, id) => this.check(String(id)),
      addServer: (_sender, address, name, allowInsecure) =>
        this.add(String(address), String(name ?? ""), allowInsecure === true),
      removeServer: async (_sender, id) => {
        const server = store.get(String(id));
        if (!server) return;
        await windows.forget(server);
        store.remove(server.id);
      },
      openServer: (_sender, id) => windows.show(String(id)),
      signIn: (_sender, id) => {
        if (store.get(String(id))) setup.signIn(String(id));
      },
      takeInvitation: () => {
        const invitation = this.invitation;
        this.invitation = null;
        return invitation;
      },
      dismissSignInBar: (sender) => windows.dismissBar(sender),
      retryServer: (sender) => windows.retryFrom(sender),
    };
    for (const [name, handle] of Object.entries(handlers)) {
      ipcMain.handle(PAGES_CHANNEL + name, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!event.senderFrame?.url.startsWith(setup.pagesUrl)) throw new Error("not an app page");
        return (handle as (sender: Electron.WebContents, ...rest: unknown[]) => unknown)(event.sender, ...args);
      });
    }
    store.onChange(() => this.win?.webContents.send(PAGES_CHANGED));
  }

  /** Shows the list, making its window when there is none. */
  show() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      name: "servers",
      windowStatePersistence: true,
      width: 560,
      height: 640,
      minWidth: 420,
      minHeight: 420,
      title: "Quadit Servers",
      // pages.css's --bg, so the window is not white until its page paints.
      backgroundColor: "#1b1d22",
      webPreferences: {
        preload: this.setup.pagesPreload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.win.webContents.on("will-navigate", (event) => event.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.on("closed", () => (this.win = undefined));
    void this.win.loadURL(new URL("servers.html", this.setup.pagesUrl).href);
  }

  /** A link asked for `path` on a server that is not added: the list offers to add it, and the page opens once it is. */
  invite(origin: string, path: string) {
    this.invitation = { origin };
    this.destination = { origin, path };
    this.show();
    this.win?.webContents.send(PAGES_CHANGED);
  }

  private async add(address: string, name: string, allowInsecure: boolean): Promise<AddResult> {
    const origin = serverOrigin(address);
    if (!origin)
      return {
        ok: false,
        error: "That is not a web address. Type it as quadit.example.com or https://quadit.example.com.",
      };
    // Asked before anything is sent to it: not even the probe goes out unencrypted unasked.
    if (transportOf(origin) === "insecure" && !allowInsecure) {
      return {
        ok: false,
        insecure: true,
        error:
          `${origin} is not encrypted (http). Anyone on the networks between this computer and the server ` +
          "could read your sign-in and everything you open, and change it. Use its https address if it has one.",
      };
    }
    const answer = await probe(origin, this.setup.fetcher);
    if (!answer.reachable) return { ok: false, error: answer.reason };
    const server = this.store.add(origin, name, answer.handoff);
    this.store.change(server.id, { version: answer.version });
    const path = this.destination?.origin === origin ? this.destination.path : undefined;
    if (path) this.destination = null;
    this.windows.show(server.id, path);
    return { ok: true, server: view(server) };
  }

  private async check(id: string): Promise<ServerStatus> {
    const answer = await this.setup.checks.check(id);
    if (!answer) return { reachable: false, reason: "This server was removed." };
    if (!answer.reachable) return answer;
    return { reachable: true, version: answer.version, fit: answer.fit };
  }
}

function view(server: Server): ServerView {
  return { id: server.id, name: server.name, origin: server.origin, transport: transportOf(server.origin) };
}
