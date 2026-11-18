// The server list: the app's own bundled page where servers are added,
// checked, opened, signed in to and removed; and what the app's pages ask
// about servers and the workspaces their windows show (the summaries).

import type { BrowserWindow } from "electron";
import type { AppPages } from "@/main/app-pages";
import { serverOrigin, transportOf } from "@/main/origins";
import { type Fetch, probe } from "@/main/probe";
import type { Requests } from "@/main/requests";
import type { ServerChecks } from "@/main/server-checks";
import type { ServerWindows } from "@/main/server-windows";
import type { Server, ServerStore } from "@/main/servers";
import type { AddResult, Invitation, ServerStatus, ServerView, SummaryView } from "@/shared/pages-api";

export interface ServerListSetup {
  /** The network the probes of servers being added go through (Electron's net.fetch). */
  fetcher: Fetch;
  /** What asks added servers what they are and keeps the answer. */
  checks: ServerChecks;
  signIn(serverId: string): void;
}

export class ServerList {
  private win: BrowserWindow | undefined;
  private invitation: Invitation | null = null;
  /** The page a link asked for on a server not added yet: opened when that server is added. */
  private destination: { origin: string; path: string } | null = null;

  constructor(
    private store: ServerStore,
    private windows: ServerWindows,
    private pages: AppPages,
    requests: Requests,
    private setup: ServerListSetup,
  ) {
    pages.answer({
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
      summaries: (): SummaryView[] =>
        requests.summaries().flatMap(({ serverId, summary, listening }) => {
          const server = store.get(serverId);
          return server ? [{ serverId, serverName: server.name, summary, listening }] : [];
        }),
      openPath: (_sender, serverId, path) => windows.show(String(serverId), String(path)),
    });
    store.onChange(() => pages.changed());
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
