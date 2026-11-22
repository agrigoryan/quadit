// Connect agents (desktop contract §11): the app's page (src/pages/connect.html)
// laid over a server's window (ServerWindows.cover), as the first run is, for
// the server and the workspace that window shows. "Done" and Escape take it
// away, showing the page that was there; so does closing the window. One at a
// time: asked for another server's window, the one shown goes first. Over a
// window the first run covers, it lays nothing: the first run, in front, has
// its own tools step.
//
// A server's page may ask for it too (its "Connect a tool on this
// computer"), and a server elsewhere is not to be trusted: it could time the
// ask so that a click the person meant for its page lands on a card's
// one-click Connect, which writes files here and signs a tool in to it. So a
// page's ask is taken only while its window is in front of the person and
// nothing of the app's covers it, never within ten seconds of the person
// leaving Connect there; and Connect opened so says which server asked and
// takes no input for its first moment on screen (src/pages/hold-input.ts).
// The person's own ways (the menu, setup) always open it.
//
// It is an app page in a view of its own, in the app's session: it gets the
// pages API and never the bridge, and the server's page under it, in its own
// web contents and partition, never gets the pages API.
//
// It answers what the page asks of Connect (connections.ts), and what any
// tool card asks, the first run's too: where a tool stands with Quadit, a new
// connect code, copying a code's line, and updating a skill changed by hand.

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
    | "updateSkill"
  >;
  windows: Pick<ServerWindows, "cover" | "uncover" | "isCovered" | "inFront">;
  /** What a server's window shows: its server, and the workspace its page published; null for a server not added. */
  target(serverId: string): Omit<ConnectTarget, "openedByPage"> | null;
  /** Puts text on the clipboard. */
  copy(text: string): Promise<void>;
  /** Shows the folder of the backups Connect keeps. */
  showBackups(): Promise<void>;
}

/** For how long a server's page may not open Connect again after the person left it over that page's window. */
const QUIET_AFTER_LEAVING_MS = 10_000;

/** Connect agents over one server's window; `byPage`: the server's page asked for it, not the person. */
interface Shown {
  view: WebContentsView;
  serverId: string;
  byPage: boolean;
}

export class ConnectPage {
  private shown: Shown | undefined;
  /** When the person last left Connect over each server's window (ms), from which its page must wait. */
  private left = new Map<string, number>();

  constructor(private parts: ConnectPageParts) {
    const { pages, connections } = parts;
    const own = (sender: WebContents) => (this.shown?.view.webContents.id === sender.id ? this.shown : undefined);
    pages.answer({
      connectTarget: (sender) => {
        const shown = own(sender);
        const target = shown && parts.target(shown.serverId);
        return target ? { ...target, openedByPage: shown.byPage } : null;
      },
      closeConnect: (sender) => {
        const shown = own(sender);
        if (shown) this.close(shown, { left: true });
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
      updateSkill: (_sender, harness) => connections.updateSkill(String(harness)),
      copyText: (_sender, text) => parts.copy(String(text)),
    });
  }

  /** The person asked: lays Connect agents over the window of the server `serverId` (made and shown when it is not), in front. */
  show(serverId: string) {
    const shown = this.shown;
    if (shown?.serverId === serverId) {
      this.parts.windows.cover(shown.view, serverId, () => this.close(shown, { left: true }));
      return;
    }
    this.open(serverId, false);
  }

  /**
   * The server's own page asked (open-connect.ts lets one ask a second
   * through): laid over its window only while that window is in front and
   * nothing of the app's covers it, and not within QUIET_AFTER_LEAVING_MS of
   * the person leaving Connect there. Asked again while there, nothing changes.
   */
  asked(serverId: string) {
    const { windows } = this.parts;
    if (this.shown?.serverId === serverId || !windows.inFront(serverId) || windows.isCovered(serverId)) return;
    if (Date.now() - (this.left.get(serverId) ?? Number.NEGATIVE_INFINITY) < QUIET_AFTER_LEAVING_MS) return;
    this.open(serverId, true);
  }

  /** Lays a new Connect over the window of `serverId`, the one shown elsewhere going first. */
  private open(serverId: string, byPage: boolean) {
    const { pages, windows } = this.parts;
    if (this.shown) this.close(this.shown, { left: false });
    const next: Shown = { view: pages.view("connect.html"), serverId, byPage };
    if (!windows.cover(next.view, serverId, () => this.close(next, { left: true }))) {
      windows.uncover(next.view);
      return;
    }
    this.shown = next;
  }

  /**
   * Takes `shown` away when it is the one shown: the window's page shows
   * again, and a plan under review is dropped. `left`: the person left it
   * (Done, Escape, closing the window), not moved it to another window.
   */
  private close(shown: Shown, { left }: { left: boolean }) {
    if (this.shown !== shown) return;
    this.shown = undefined;
    if (left) this.left.set(shown.serverId, Date.now());
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
  };
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}
