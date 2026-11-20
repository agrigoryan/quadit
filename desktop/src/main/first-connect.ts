// The first run's last step (desktop contract §8), in Welcome: right after
// Quadit is set up on this computer, the agent tools found here, each
// connected with one button and nothing asked. It is Connect
// (connections.ts) with the choices made for the person: the quadit command
// and its skill (not MCP), the workspace just made, the tool's own agent
// (made, or the one there already), and no "without asking each time". The
// full Connect window keeps every choice ("More options…").

import type { Connections } from "@/main/connections";
import type { DesktopSummary } from "@/shared/bridge";
import type { ConnectChoice, Planned, PlanView } from "@/shared/pages-api";

export interface FirstConnectParts {
  connections: Pick<Connections, "state" | "planConnect" | "applyConnect" | "dropPlans">;
  /** The workspaces the server windows show now (Requests.summaries). */
  summaries(): { serverId: string; summary: DesktopSummary; listening: boolean }[];
  sleep(ms: number): Promise<void>;
}

/** A tool the step offers. */
export interface FoundTool {
  id: string;
  name: string;
}

/** How long Connect waits for the new workspace's window to show it: it has just been opened. */
const WINDOW_WAIT_MS = 30_000;
const WINDOW_POLL_MS = 250;

export class FirstConnect {
  /** The workspace the step connects to, and the tools it offers; null when there is no step. */
  private step: { serverId: string; workspace: string; tools: FoundTool[] } | null = null;
  /** What connecting each tool did, as its plan showed it. */
  private done = new Map<string, PlanView>();
  /** One thing at a time: Connect keeps one plan, which a second would replace. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private parts: FirstConnectParts) {}

  /**
   * Begins the step for the workspace just made (`workspace`, its slug) on
   * the server `serverId`; gives the tools it offers: those found on this
   * computer and not connected yet. None: there is no step.
   */
  async begin(serverId: string, workspace: string): Promise<FoundTool[]> {
    const { harnesses } = await this.parts.connections.state();
    const tools = harnesses.filter((h) => h.installed && !h.connected).map((h) => ({ id: h.id, name: h.name }));
    this.done.clear();
    this.step = tools.length > 0 ? { serverId, workspace, tools } : null;
    return tools;
  }

  /** Connects a tool the step offers, with its choices. */
  connect(toolId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.inTurn(async () => {
      const planned = await this.plan(toolId);
      if (!planned.ok) return planned;
      const applied = await this.parts.connections.applyConnect(planned.plan.id);
      if (!applied.ok) return applied;
      this.done.set(toolId, planned.plan);
      return { ok: true };
    });
  }

  /** What connecting a tool changes: the plan as it would be now, dropped again, or the one carried out. */
  changes(toolId: string): Promise<Planned> {
    return this.inTurn(async () => {
      const done = this.done.get(toolId);
      if (done) return { ok: true, plan: done };
      const planned = await this.plan(toolId);
      this.parts.connections.dropPlans();
      return planned;
    });
  }

  /** The step is over: skipped or done. It never comes back by itself. */
  end() {
    this.step = null;
  }

  private async plan(toolId: string): Promise<Planned> {
    const step = this.step;
    const tool = step?.tools.find((t) => t.id === toolId);
    if (!step || !tool) return { ok: false, error: "That tool is not offered here: connect it from Connect Agents…" };
    const shown = await this.workspaceShown(step.serverId, step.workspace);
    if (!shown) return { ok: false, error: "Your workspace's window has not finished opening. Try again in a moment." };
    const handle = handleOf(tool.name);
    const agent = shown.agents.find((a) => a.handle === handle && a.usable);
    const choice: ConnectChoice = {
      harness: tool.id,
      serverId: step.serverId,
      workspaceId: shown.workspace.id,
      methods: ["cli"],
      agent: agent ? { id: agent.id } : { create: { name: tool.name, handle } },
      allowUnattended: false,
    };
    return this.parts.connections.planConnect(choice);
  }

  /** The workspace as its window shows it, once it does (it has just been opened); null when it does not in time. */
  private async workspaceShown(serverId: string, slug: string): Promise<DesktopSummary | null> {
    for (let waited = 0; ; waited += WINDOW_POLL_MS) {
      const shown = this.parts
        .summaries()
        .find((s) => s.serverId === serverId && s.summary.workspace.slug === slug && s.listening);
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

/** A tool's agent handle, from its name: "Claude Code" is @claude-code. */
function handleOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
