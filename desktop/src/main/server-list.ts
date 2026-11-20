// The server list: the app's own bundled page where servers are added,
// checked, opened, signed in to and removed; and what the app's pages ask
// about servers and the workspaces their windows show (the summaries).
//
// The server the app runs on this computer (local-server.ts) is one of the
// list's servers, named "This computer", with its state and controls beside
// it. There is one at most. Removing it stops it and keeps its data folder.
// Setting it up (Welcome's "Set up on this computer") is here too.

import { type BrowserWindow, shell } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { LocalServer } from "@/main/local-server";
import { serverOrigin, transportOf } from "@/main/origins";
import { type Fetch, probe } from "@/main/probe";
import type { Requests } from "@/main/requests";
import type { ServerChecks } from "@/main/server-checks";
import type { ServerWindows } from "@/main/server-windows";
import type { Server, ServerStore } from "@/main/servers";
import type {
  AddResult,
  Invitation,
  LocalControl,
  LocalServerView,
  ServerStatus,
  ServerView,
  SummaryView,
} from "@/shared/pages-api";

/** What the server on this computer is called in the list. */
export const LOCAL_NAME = "This computer";

/** What the list needs of the server on this computer. */
type Local = Pick<
  LocalServer,
  "available" | "dataDir" | "logFile" | "origin" | "state" | "setUp" | "setUpOwner" | "start" | "stop" | "restart"
>;

/** What the list needs of the servers' windows. */
type Windows = Pick<ServerWindows, "show" | "showAfresh" | "fetcher" | "forget" | "dismissBar" | "retryFrom">;

export interface ServerListSetup {
  /** The network the probes of servers being added go through (Electron's net.fetch). */
  fetcher: Fetch;
  /** What asks added servers what they are and keeps the answer. */
  checks: ServerChecks;
  signIn(serverId: string): void;
  /** The server the app runs on this computer. */
  local: Local;
  /** Whether the app starts at login, and the switch; null where the app does not offer it. */
  loginItem: { get(): boolean; set(on: boolean): void } | null;
  /** Shows the Connect agents window. */
  openConnect(): void;
}

export class ServerList {
  private win: BrowserWindow | undefined;
  private invitation: Invitation | null = null;
  /** The page a link asked for on a server not added yet: opened when that server is added. */
  private destination: { origin: string; path: string } | null = null;

  constructor(
    private store: ServerStore,
    private windows: Windows,
    private pages: Pick<AppPages, "answer" | "changed" | "window">,
    requests: Pick<Requests, "summaries">,
    private setup: ServerListSetup,
  ) {
    pages.answer({
      listServers: () => store.list().map((server) => this.view(server)),
      checkServer: (_sender, id) => this.check(String(id)),
      addServer: (_sender, address, name, allowInsecure) =>
        this.add(String(address), String(name ?? ""), allowInsecure === true),
      removeServer: async (_sender, id) => {
        const server = store.get(String(id));
        if (!server) return;
        if (this.isLocal(server)) {
          // Its data stays; the person can run it again and have it back.
          await setup.local.stop();
          setup.loginItem?.set(false);
        }
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
      summaries: (): SummaryView[] =>
        requests.summaries().flatMap(({ serverId, summary, listening }) => {
          const server = store.get(serverId);
          return server ? [{ serverId, serverName: server.name, summary, listening }] : [];
        }),
      openPath: (_sender, serverId, path) => windows.show(String(serverId), String(path)),
      localServer: () => this.localView(),
      setUpHere: (_sender, name) => this.setUpHere(typeof name === "string" ? name : ""),
      controlLocalServer: (_sender, control) => this.control(control),
      showLocalServerFiles: (_sender, what) => {
        if (what === "log") shell.showItemInFolder(setup.local.logFile);
        else void shell.openPath(setup.local.dataDir);
      },
      setOpenAtLogin: (_sender, on) => {
        setup.loginItem?.set(on === true);
        pages.changed();
      },
    });
    store.onChange(() => pages.changed());
  }

  /** The server on this computer, when it is in the list. */
  localServer(): Server | undefined {
    const origin = this.setup.local.origin();
    return origin ? this.store.byOrigin(origin) : undefined;
  }

  /**
   * Sets Quadit up on this computer (desktop contract §7): starts the server
   * the app runs here (the one set up before, with its data, when there is
   * one), adds it to the list, makes its owner `name` and their workspace
   * through its window's own session, and opens that window on the
   * workspace, signed in. On an install set up already it signs in instead,
   * so trying again after a half-finished attempt works. Right after the
   * owner is made, and only then, Connect agents opens over the window.
   */
  async setUpHere(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const { local } = this.setup;
    let origin: string;
    try {
      origin = await local.setUp();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Saved before its owner is made: quit before that, the next start finds its set-up unfinished and offers
    // Welcome again (main.ts). Its hand-off is asked once it runs.
    const server = this.store.add(origin, LOCAL_NAME, 0);
    const owner = await local.setUpOwner(this.windows.fetcher(server.id), name.trim());
    if (!owner.ok) return owner;
    // Its window may be open already, on the web app's page saying the app sets it up: it starts over, signed in.
    this.windows.showAfresh(server.id, owner.path);
    if (owner.first) this.setup.openConnect();
    return { ok: true };
  }

  /** Starts, stops or restarts the server on this computer. */
  async control(control: LocalControl) {
    const { local } = this.setup;
    if (!this.localServer()) return;
    if (control === "start") local.start();
    else if (control === "stop") await local.stop();
    else if (control === "restart") await local.restart();
  }

  /** Shows the list, making its window when there is none. */
  show() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = this.pages.window("servers.html", {
      name: "servers",
      windowStatePersistence: true,
      width: 560,
      height: 640,
      minWidth: 420,
      minHeight: 420,
      title: "Quadit Servers",
    });
    this.win.on("closed", () => (this.win = undefined));
  }

  /** A link asked for `path` on a server that is not added: the list offers to add it, and the page opens once it is. */
  invite(origin: string, path: string) {
    this.invitation = { origin };
    this.destination = { origin, path };
    this.show();
    this.pages.changed();
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
    return { ok: true, server: this.view(server) };
  }

  private async check(id: string): Promise<ServerStatus> {
    const answer = await this.setup.checks.check(id);
    if (!answer) return { reachable: false, reason: "This server was removed." };
    if (!answer.reachable) return answer;
    return { reachable: true, version: answer.version, fit: answer.fit };
  }

  private isLocal(server: Server): boolean {
    return server.origin === this.setup.local.origin();
  }

  private view(server: Server): ServerView {
    return {
      id: server.id,
      name: server.name,
      origin: server.origin,
      transport: transportOf(server.origin),
      local: this.isLocal(server),
    };
  }

  private localView(): LocalServerView {
    const { local, loginItem } = this.setup;
    const serverId = this.localServer()?.id ?? null;
    return {
      available: local.available,
      serverId,
      state: local.state(),
      dataDir: local.dataDir,
      dataKept: serverId === null && local.origin() !== null,
      openAtLogin: loginItem ? loginItem.get() : null,
    };
  }
}
