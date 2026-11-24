// Connect agents (desktop contract §11): the app's page (src/pages/connect.html)
// laid over a server's window (ServerWindows.cover), as the first run is, for
// the server and the workspace that window shows. "Done" and Escape take it
// away, showing the page that was there; so does closing the window. One at a
// time: asked for another server's window, the one shown goes first. Over a
// window the first run covers, it lays nothing: the first run, in front, has
// its own tools step.
//
// A server's page may ask for it too (its "Connect a tool on this
// computer"); never over the first run. The app's own server's page opens it
// as the person would. A server elsewhere is not to be trusted: it could time
// the ask so that a click the person meant for its page lands on a card's
// one-click Connect, which writes files here and signs a tool in to it. So
// Connect opened by such a page says which server asked and takes no input
// for its first moment on screen (src/pages/hold-input.ts).
//
// It is an app page in a view of its own, in the app's session: it gets the
// pages API and never the bridge, and the server's page under it, in its own
// web contents and partition, never gets the pages API.
//
// It answers what the page asks of Connect (connections.ts), and what any
// tool card asks, the first run's too: where a tool stands with Quadit, a new
// connect code, copying a code's line, updating a skill changed by hand, and
// Run by Quadit (runner.ts): the projects Quadit runs a connected Claude
// Code's or Codex's agent for, starting and stopping one, the folder picker.

import { isAbsolute } from "node:path";
import type { WebContents, WebContentsView } from "electron";
import type { AppPages } from "@/main/app-pages";
import { type Connections, homely } from "@/main/connections";
import type { Runner } from "@/main/runner";
import { type ConnectFocus, isProjectKey } from "@/shared/bridge";
import type { SelfRuns } from "@/main/self-runs";
import type { ServerWindows } from "@/main/server-windows";
import type { ConnectChoice, ConnectFocusView, ConnectTarget, Refused } from "@/shared/pages-api";

export interface ConnectPageParts {
  pages: Pick<AppPages, "answer" | "view" | "changed">;
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
    | "runAs"
    | "skillForRuns"
    | "agentsOf"
  >;
  windows: Pick<ServerWindows, "cover" | "uncover" | "isCovered">;
  /** Whether `serverId` is the server the app runs on this computer. */
  isLocal(serverId: string): boolean;
  /** What a server's window shows: its server, and the workspace its page published; null for a server not added. */
  target(serverId: string): Omit<ConnectTarget, "openedByPage"> | null;
  /** Puts text on the clipboard. */
  copy(text: string): Promise<void>;
  /** What the app runs by itself for the tools (self-runs.ts). */
  selfRuns: Pick<SelfRuns, "self" | "logOf">;
  /** Opens a log file. */
  showLog(path: string): Promise<void>;
  /** Shows the folder of the backups Connect keeps. */
  showBackups(): Promise<void>;
  /** Quadit running agents for projects of this computer (runner.ts). */
  runner: Pick<Runner, "available" | "entries" | "projects" | "waiting" | "add" | "remove" | "logFile">;
  /** Where a tool's program is, as the app finds it (tool-program.ts); null when it is not found. */
  programOf(toolId: string): Promise<string | null>;
  /** The native folder picker over the window of the page `sender`; null when cancelled. */
  pickFolder(sender: WebContents): Promise<string | null>;
  /** The home folder, written ~ in the folders the pages show. */
  home: string;
}

const NOT_RUN: Refused = { ok: false, error: "Quadit cannot run this tool for a project." };

/**
 * Connect agents over one server's window; `byPage`: another server's page
 * asked for it, not the person; `focus`, where that page wants it, and the
 * number of that ask.
 */
interface Shown {
  view: WebContentsView;
  serverId: string;
  byPage: boolean;
  focus: { asked: ConnectFocus; id: number } | null;
}

export class ConnectPage {
  private shown: Shown | undefined;
  /** How many focused asks there have been: each focus has its own number, so the page does each once. */
  private asks = 0;

  constructor(private parts: ConnectPageParts) {
    const { pages, connections } = parts;
    const own = (sender: WebContents) => (this.shown?.view.webContents.id === sender.id ? this.shown : undefined);
    pages.answer({
      connectTarget: (sender) => {
        const shown = own(sender);
        const target = shown && parts.target(shown.serverId);
        if (!target) return null;
        const focus = this.focusOf(shown, target);
        return { ...target, openedByPage: shown.byPage, ...(focus ? { focus } : {}) };
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
      updateSkill: (_sender, harness) => connections.updateSkill(String(harness)),
      toolSelf: (_sender, harness) => parts.selfRuns.self(String(harness)),
      showToolLog: (_sender, harness) => parts.showLog(parts.selfRuns.logOf(String(harness))),
      copyText: (_sender, text) => parts.copy(String(text)),
      runEntries: async (_sender, harness) => {
        const tool = this.runAs(String(harness));
        if (!tool) return null;
        const entries = await parts.runner.entries(tool.login);
        return { agent: tool.agent, entries: entries ?? [], ...(entries ? {} : { unreadable: true as const }) };
      },
      runWaiting: async (_sender, harness, project) => {
        const tool = this.runAs(String(harness));
        return tool && isProjectKey(project) ? parts.runner.waiting(tool.login, project) : null;
      },
      agentProjects: (_sender, harness) => {
        const tool = this.runAs(String(harness));
        return tool ? parts.runner.projects(tool.login) : NOT_RUN;
      },
      pickFolder: async (sender) => {
        const path = await parts.pickFolder(sender);
        return path ? { path, shown: homely(parts.home, path) } : null;
      },
      startRunning: async (_sender, harness, project, folder) => {
        const tool = this.runAs(String(harness));
        if (!tool) return NOT_RUN;
        // What the page sends goes to quadit run add as arguments: a project key's form, a whole path.
        if (!isProjectKey(project)) return { ok: false, error: "That is not a project of this workspace." };
        if (typeof folder !== "string" || !isAbsolute(folder) || folder.includes("\0"))
          return { ok: false, error: "Choose the folder again." };
        // The agent's skill must tell it how a run Quadit starts goes: brought up to date, else no run.
        const skill = await connections.skillForRuns(tool.program);
        if (!skill.ok) return skill;
        const programPath = (await parts.programOf(tool.program)) ?? undefined;
        return parts.runner.add({ login: tool.login, project, folder, program: tool.program, programPath });
      },
      stopRunning: async (_sender, harness, entry) => {
        const tool = this.runAs(String(harness));
        if (!tool) return NOT_RUN;
        // Only an entry of this tool's agent: the page names it by its id.
        if (!(await parts.runner.entries(tool.login))?.some((e) => e.id === entry))
          return { ok: false, error: `Quadit does not run that project for ${tool.agent}.` };
        return parts.runner.remove({ entry: String(entry) });
      },
      showRunnerLog: async () => {
        const file = await parts.runner.logFile();
        if (file) await parts.showLog(file);
      },
    });
  }

  /** The agent Quadit can run the tool `harness` as: none when the app carries no quadit to run it with. */
  private runAs(harness: string) {
    return this.parts.runner.available ? this.parts.connections.runAs(harness) : null;
  }

  /** The person asked: lays Connect agents over the window of the server `serverId` (made and shown when it is not), in front. */
  show(serverId: string) {
    const shown = this.shown;
    if (shown?.serverId === serverId) {
      this.parts.windows.cover(shown.view, serverId, () => this.close(shown));
      return;
    }
    this.open(serverId, false);
  }

  /**
   * The server's own page asked (open-connect.ts lets one ask a second
   * through): laid over its window unless the first run covers it. Asked
   * again while there, nothing changes.
   */
  asked(serverId: string, focus: ConnectFocus | null = null) {
    if (this.parts.windows.isCovered(serverId)) return;
    const asked = focus ? { asked: focus, id: ++this.asks } : null;
    if (this.shown?.serverId === serverId) {
      // There already: only a new focus changes anything, which the page is told of.
      if (!asked) return;
      this.shown.focus = asked;
      this.parts.pages.changed();
      return;
    }
    this.open(serverId, !this.parts.isLocal(serverId), asked);
  }

  /**
   * Where the page that asked wants Connect agents, as the page is to do it
   * (ConnectFocusView): at the card of the tool that works as that agent of
   * the workspace shown, else at that agent, when the workspace has it;
   * nothing when neither (another workspace's agent, or none).
   */
  private focusOf(shown: Shown, target: Omit<ConnectTarget, "openedByPage">): ConnectFocusView | null {
    const { focus } = shown;
    const workspace = target.summary?.workspace.id;
    if (!focus?.asked.agent || !workspace) return null;
    const { agent, intent } = focus.asked;
    const tool = this.parts.connections.agentsOf(shown.serverId, workspace).find((a) => a.agent === agent)?.tool;
    const handle = target.summary?.agents.find((a) => a.id === agent)?.handle;
    if (!tool && !handle) return null;
    return {
      id: focus.id,
      ...(intent ? { intent } : {}),
      ...(tool ? { tool } : {}),
      ...(handle ? { agent: { id: agent, handle } } : {}),
    };
  }

  /** Lays a new Connect over the window of `serverId`, the one shown elsewhere going first. */
  private open(serverId: string, byPage: boolean, focus: Shown["focus"] = null) {
    const { pages, windows } = this.parts;
    if (this.shown) this.close(this.shown);
    const next: Shown = { view: pages.view("connect.html"), serverId, byPage, focus };
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
  };
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}
