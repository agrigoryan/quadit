// The first run's second step (desktop contract §10, "Connect your AI
// tools"), as the app does it, for one workspace this app has just set up:
// it looks for the agent tools here (the page shows the looking for at least
// about a second: shared/looking.ts), connects each with one button and
// nothing asked (the default choice of shared/default-choice.ts) or with the
// plan "See the files" showed, takes one back with Undo, and at the end asks
// the workspace's page for its sample tasks, the third handed to the first
// tool connected that is an agent there, and opens the path returned. It is
// Connect (connections.ts) with the choices made for the person; the Connect
// window keeps every choice.
//
// One is made for each run of the first run (first-run.ts), so that work a
// closed run started never touches a later one. What it does is done one
// thing at a time, in the order asked: Connect keeps one plan, which a second
// would replace, and the end must see every Connect and Undo asked before it.
// Once the end has begun, nothing new is taken, until it fails.

import type { Connections } from "@/main/connections";
import type { DesktopOutcome, DesktopRequest, DesktopSummary } from "@/shared/bridge";
import { defaultLoginWords } from "@/shared/change-words";
import { defaultChoice } from "@/shared/default-choice";
import type { FoundTools, Planned, PlanView, Refused, ToolView } from "@/shared/pages-api";

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

const FINISHING: Refused = { ok: false, error: "Quadit is opening your workspace." };

export class FirstConnect {
  /** The tools the last look found here and offered. */
  private offered: ToolView[] = [];
  /** What connecting each tool did, and the agent of this workspace it works as, in the order they were connected. */
  private done = new Map<string, { plan: PlanView; agent: string | null }>();
  /** The plan "See the files" showed for each tool, which its Connect there applies. */
  private reviewed = new Map<string, PlanView>();
  private queue: Promise<unknown> = Promise.resolve();
  /** The end has begun: nothing new is taken. */
  private finishing = false;

  /** The step for the workspace `workspace` (its slug) on the server `serverId`, which this app has just set up. */
  constructor(
    private parts: FirstConnectParts,
    readonly serverId: string,
    readonly workspace: string,
  ) {}

  /**
   * Looks for the agent tools on this computer: every tool Connect knows,
   * found or not, but those connected before the step (to whatever server),
   * which it leaves alone; and whether connecting puts the quadit command here.
   */
  async look(): Promise<FoundTools> {
    const { harnesses, cli, defaultLogin } = await this.parts.connections.state();
    const tools = harnesses
      .filter((h) => !h.connected || this.done.has(h.id))
      .map((h) => ({
        id: h.id,
        name: h.name,
        initials: h.initials,
        found: h.installed,
        ownLogin: h.cliIdentity === "own",
        worksAs: h.cliIdentity === "default" ? defaultLoginWords(defaultLogin) : null,
      }));
    this.offered = tools.filter((t) => t.found);
    return { tools, addsCommand: !cli.found && cli.linkInto !== null };
  }

  /**
   * Connects a tool the step offers: with the plan "See the files" showed for
   * it when `planId` names that one, else with the default choice. Gives the
   * handle of the workspace's agent it works as (null: none of this workspace).
   */
  connect(toolId: string, planId?: string): Promise<{ ok: true; agent: string | null } | Refused> {
    if (this.finishing) return Promise.resolve(FINISHING);
    return this.inTurn(async () => {
      const reviewed = this.reviewed.get(toolId);
      this.reviewed.delete(toolId);
      if (planId !== undefined && reviewed?.id !== planId)
        return { ok: false, error: "That plan is gone: review the changes again.", stale: true };
      const planned: Planned =
        reviewed && planId !== undefined ? { ok: true, plan: reviewed } : await this.plan(toolId);
      if (!planned.ok) return planned;
      const applied = await this.parts.connections.applyConnect(planned.plan.id);
      if (!applied.ok) return applied;
      this.done.set(toolId, { plan: planned.plan, agent: applied.agent?.id ?? null });
      return { ok: true, agent: applied.agent?.handle ?? null };
    });
  }

  /** Takes back what connecting a tool in this step did (its Undo), asking nothing; gives what the person should know. */
  disconnect(toolId: string): Promise<{ ok: true; notes: string[] } | Refused> {
    if (this.finishing) return Promise.resolve(FINISHING);
    return this.inTurn(async () => {
      if (!this.done.has(toolId)) return { ok: false, error: "It was not connected here." };
      const planned = this.parts.connections.planDisconnect(toolId);
      if (!planned.ok) return planned;
      const applied = await this.parts.connections.applyDisconnect(planned.plan.id);
      if (!applied.ok) return applied;
      this.done.delete(toolId);
      return applied;
    });
  }

  /**
   * What connecting a tool changes: the plan as it would be now, kept for
   * that tool's Connect from "See the files", or the one carried out.
   */
  changes(toolId: string): Promise<Planned> {
    return this.inTurn(async () => {
      const done = this.done.get(toolId);
      if (done) return { ok: true, plan: done.plan };
      const planned = await this.plan(toolId);
      if (planned.ok) this.reviewed.set(toolId, planned.plan);
      return planned;
    });
  }

  /**
   * The end of the step, once every Connect and Undo asked before it is
   * done: asks the workspace's page for its sample tasks, the third for the
   * first tool connected that is an agent there; gives the path to open. A
   * failure is said, and the step takes work again, so the end can be tried again.
   */
  finish(open: (path: string) => Promise<boolean>): Promise<{ ok: true } | Refused> {
    this.finishing = true;
    return this.inTurn(async () => {
      const shown = await this.workspaceShown();
      const outcome = shown
        ? await this.parts.ask(this.serverId, shown.workspace.id, this.samplesRequest())
        : ({ ok: false, message: "its window has not finished opening" } as const);
      if (outcome.ok && (await open(outcome.path ?? `/${encodeURIComponent(this.workspace)}`))) return { ok: true };
      this.finishing = false;
      return {
        ok: false,
        error: outcome.ok
          ? "Could not open the page in your workspace. Try again."
          : `Your workspace did not answer: ${outcome.message.replace(/\.$/, "")}. Try again.`,
      };
    });
  }

  /** The request that ends the first run: the samples, for the first tool connected that has an agent here. */
  samplesRequest(): DesktopRequest {
    const agent = [...this.done.values()].find((d) => d.agent)?.agent;
    return agent ? { kind: "samples", agent } : { kind: "samples" };
  }

  private async plan(toolId: string): Promise<Planned> {
    const tool = this.offered.find((t) => t.id === toolId);
    if (!tool) return { ok: false, error: "That tool is not offered here: connect it from Connect Agents…" };
    const shown = await this.workspaceShown();
    if (!shown) return { ok: false, error: "Your workspace's window has not finished opening. Try again in a moment." };
    return this.parts.connections.planConnect(defaultChoice(tool, this.serverId, shown));
  }

  /** The workspace as its window shows it, once it does (it has just been opened); null when it does not in time. */
  private async workspaceShown(): Promise<DesktopSummary | null> {
    for (let waited = 0; ; waited += WINDOW_POLL_MS) {
      const shown = this.parts
        .summaries()
        .find((s) => s.serverId === this.serverId && s.listening && s.summary.workspace.slug === this.workspace);
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
