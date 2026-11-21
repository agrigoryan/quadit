// Connect agents (desktop contract §11): the app's page (src/pages/connect.html)
// laid over a server's window (ServerWindows.cover), as the first run is, for
// the server and the workspace that window shows. "Done" and Escape take it
// away, showing the page that was there; so does closing the window. One at a
// time: asked for another server's window, the one shown goes first. Over a
// window the first run covers, it lays nothing: the first run, in front, has
// its own tools step.
//
// It is an app page in a view of its own, in the app's session: it gets the
// pages API and never the bridge, and the server's page under it, in its own
// web contents and partition, never gets the pages API.
//
// It answers what the page asks of Connect (connections.ts), and what any
// tool card asks, the first run's too: where a tool stands with Quadit, a new
// connect code, and copying a code's line.

import type { WebContents, WebContentsView } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { Connections } from "@/main/connections";
import type { ServerWindows } from "@/main/server-windows";
import type { ConnectChoice, ConnectTarget } from "@/shared/pages-api";

export interface ConnectPageParts {
  pages: Pick<AppPages, "answer" | "view">;
  connections: Pick<
    Connections,
    | "state"
    | "planConnect"
    | "applyConnect"
    | "planDisconnect"
    | "applyDisconnect"
    | "dropPlans"
    | "handshake"
    | "newCode"
  >;
  windows: Pick<ServerWindows, "cover" | "uncover">;
  /** What a server's window shows: its server, and the workspace its page published; null for a server not added. */
  target(serverId: string): ConnectTarget | null;
  /** Puts text on the clipboard. */
  copy(text: string): Promise<void>;
  /** Shows the folder of the backups Connect keeps. */
  showBackups(): Promise<void>;
}

/** Connect agents over one server's window. */
interface Shown {
  view: WebContentsView;
  serverId: string;
}

export class ConnectPage {
  private shown: Shown | undefined;

  constructor(private parts: ConnectPageParts) {
    const { pages, connections } = parts;
    const own = (sender: WebContents) => (this.shown?.view.webContents.id === sender.id ? this.shown : undefined);
    pages.answer({
      connectTarget: (sender) => {
        const shown = own(sender);
        return shown ? parts.target(shown.serverId) : null;
      },
      closeConnect: (sender) => {
        const shown = own(sender);
        if (shown) this.close(shown);
      },
      connectState: () => connections.state(),
      planConnect: (_sender, choice) => connections.planConnect(choiceOf(choice)),
      applyConnect: (_sender, planId) => connections.applyConnect(String(planId)),
      planDisconnect: (_sender, harness) => connections.planDisconnect(String(harness)),
      applyDisconnect: (_sender, planId) => connections.applyDisconnect(String(planId)),
      dropPlan: () => connections.dropPlans(),
      showBackups: () => parts.showBackups(),
      toolHandshake: (_sender, harness) => connections.handshake(String(harness)),
      newConnectCode: (_sender, harness) => connections.newCode(String(harness)),
      copyText: (_sender, text) => parts.copy(String(text)),
    });
  }

  /** Lays Connect agents over the window of the server `serverId` (made and shown when it is not), in front. */
  show(serverId: string) {
    const { pages, windows } = this.parts;
    const shown = this.shown;
    if (shown?.serverId === serverId) {
      windows.cover(shown.view, serverId, () => this.close(shown));
      return;
    }
    if (shown) this.close(shown);
    const next: Shown = { view: pages.view("connect.html"), serverId };
    if (!windows.cover(next.view, serverId, () => this.close(next))) {
      windows.uncover(next.view);
      return;
    }
    this.shown = next;
  }

  /** Takes `shown` away when it is the one shown: the window's page shows again, and a plan under review is dropped. */
  private close(shown: Shown) {
    if (this.shown !== shown) return;
    this.shown = undefined;
    this.parts.windows.uncover(shown.view);
    this.parts.connections.dropPlans();
  }
}

/** What the page sent as a choice, with its types checked; anything wrong reads as nothing chosen, which Connect refuses. */
function choiceOf(raw: unknown): ConnectChoice {
  const c = (raw ?? {}) as Record<string, unknown>;
  const agent = (c.agent ?? {}) as Record<string, unknown>;
  const create = (agent.create ?? {}) as Record<string, unknown>;
  return {
    harness: text(c.harness),
    serverId: text(c.serverId),
    workspaceId: text(c.workspaceId),
    methods: Array.isArray(c.methods) ? c.methods.filter((m) => m === "cli" || m === "mcp") : [],
    agent:
      c.agent === null
        ? null
        : typeof agent.id === "string"
          ? { id: agent.id }
          : { create: { name: text(create.name), handle: text(create.handle) } },
    allowUnattended: c.allowUnattended === true,
  };
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}
