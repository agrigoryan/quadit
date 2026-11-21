// The first run's second step (desktop contract §10, "Connect your AI
// tools"), as the app does it: right after Quadit is set up on this
// computer, it looks for the agent tools here (the page shows the looking
// for at least about a second: shared/looking.ts), connects each with one button and
// nothing asked (the default choice of shared/default-choice.ts), takes one
// back with Undo, and shows what connecting changes. At the end it asks the
// workspace's page for its sample tasks, the third handed to the first tool
// connected, and gives the path to open. It is Connect (connections.ts) with
// the choices made for the person; the Connect window keeps every choice.

import type { Connections } from "@/main/connections";
import type { DesktopOutcome, DesktopRequest, DesktopSummary } from "@/shared/bridge";
import { defaultChoice } from "@/shared/default-choice";
import type { FoundTools, Planned, PlanView, ToolView } from "@/shared/pages-api";

export interface FirstConnectParts {
  connections: Pick<
    Connections,
    "state" | "planConnect" | "applyConnect" | "planDisconnect" | "applyDisconnect" | "dropPlans"
  >;
  /** The workspaces the server windows show now (Requests.summaries). */
  summaries(): { serverId: string; summary: DesktopSummary; listening: boolean }[];
  /** Asks the page that speaks for a workspace (Requests.toWorkspace). */
  ask(serverId: string, workspaceId: string, request: DesktopRequest): Promise<DesktopOutcome>;
  sleep(ms: number): Promise<void>;
}
/** How long Connect waits for the new workspace's window to show it: it has just been opened. */
const WINDOW_WAIT_MS = 30_000;
const WINDOW_POLL_MS = 250;

export class FirstConnect {
  /** The server and workspace (its slug; null: whichever its window shows) the step connects to; null when there is no step. */
  private step: { serverId: string; workspace: string | null } | null = null;
  /** The tools the last look found here and offered. */
  private offered: ToolView[] = [];
  /** What connecting each tool did, and its agent, in the order they were connected. */
  private done = new Map<string, { plan: PlanView; agent: string | null }>();
  /** One thing at a time: Connect keeps one plan, which a second would replace. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private parts: FirstConnectParts) {}

  /** Begins the step for the workspace `workspace` (its slug; null when the install was set up before) on `serverId`. */
  begin(serverId: string, workspace: string | null) {
    this.step = { serverId, workspace };
    this.offered = [];
    this.done.clear();
  }

  /**
   * Looks for the agent tools on this computer: every tool Connect knows,
   * found or not, but those connected before the step (to whatever server),
   * which it leaves alone; and whether connecting puts the quadit command here.
   */
  async look(): Promise<FoundTools> {
    const { harnesses, cli } = await this.parts.connections.state();
    const tools = harnesses
      .filter((h) => !h.connected || this.done.has(h.id))
      .map((h) => ({
        id: h.id,
        name: h.name,
        initials: h.initials,
        found: h.installed,
        ownLogin: h.cliIdentity === "own",
      }));
    this.offered = tools.filter((t) => t.found);
    return { tools, addsCommand: !cli.found && cli.linkInto !== null };
  }

  /** Connects a tool the step offers, with the default choice. */
  connect(toolId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.inTurn(async () => {
      const planned = await this.plan(toolId);
      if (!planned.ok) return planned;
      const applied = await this.parts.connections.applyConnect(planned.plan.id);
      if (!applied.ok) return applied;
      this.done.set(toolId, { plan: planned.plan, agent: applied.agent?.id ?? null });
      return { ok: true };
    });
  }

  /** Takes back what connecting a tool in this step did (its Undo), asking nothing. */
  disconnect(toolId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.inTurn(async () => {
      if (!this.done.has(toolId)) return { ok: false, error: "It was not connected here." };
      const planned = this.parts.connections.planDisconnect(toolId);
      if (!planned.ok) return planned;
      const applied = await this.parts.connections.applyDisconnect(planned.plan.id);
      if (!applied.ok) return applied;
      this.done.delete(toolId);
      return { ok: true };
    });
  }

  /** What connecting a tool changes: the plan as it would be now, dropped again, or the one carried out. */
  changes(toolId: string): Promise<Planned> {
    return this.inTurn(async () => {
      const done = this.done.get(toolId);
      if (done) return { ok: true, plan: done.plan };
      const planned = await this.plan(toolId);
      this.parts.connections.dropPlans();
      return planned;
    });
  }

  /**
   * The end of the step: asks the workspace's page for its sample tasks, the
   * third for the agent of the first tool connected that still is; gives the
   * path the page answered (the "Getting started" project), or null when it
   * did not (an older web app, or no window showing the workspace).
   */
  async finish(): Promise<string | null> {
    const step = this.step;
    if (!step) return null;
    const shown = await this.workspaceShown(step.serverId, step.workspace);
    if (!shown) return null;
    const outcome = await this.parts.ask(step.serverId, shown.workspace.id, this.samplesRequest());
    return outcome.ok && outcome.path ? outcome.path : null;
  }

  /** The request that ends the first run: the samples, for the first tool connected that has an agent here. */
  samplesRequest(): DesktopRequest {
    const agent = [...this.done.values()].find((d) => d.agent)?.agent;
    return agent ? { kind: "samples", agent } : { kind: "samples" };
  }

  /** The step is over: skipped or done. It never comes back by itself. */
  end() {
    this.step = null;
    this.offered = [];
  }

  private async plan(toolId: string): Promise<Planned> {
    const step = this.step;
    const tool = this.offered.find((t) => t.id === toolId);
    if (!step || !tool) return { ok: false, error: "That tool is not offered here: connect it from Connect Agents…" };
    const shown = await this.workspaceShown(step.serverId, step.workspace);
    if (!shown) return { ok: false, error: "Your workspace's window has not finished opening. Try again in a moment." };
    return this.parts.connections.planConnect(defaultChoice(tool, step.serverId, shown));
  }

  /** The workspace as its window shows it, once it does (it has just been opened); null when it does not in time. */
  private async workspaceShown(serverId: string, slug: string | null): Promise<DesktopSummary | null> {
    for (let waited = 0; ; waited += WINDOW_POLL_MS) {
      const shown = this.parts
        .summaries()
        .find((s) => s.serverId === serverId && s.listening && (slug === null || s.summary.workspace.slug === slug));
      if (shown) return shown.summary;
      if (waited >= WINDOW_WAIT_MS) return null;
      await this.parts.sleep(WINDOW_POLL_MS);
    }
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(work);
    this.queue = turn.catch(() => {});
    return turn;
  }
}
