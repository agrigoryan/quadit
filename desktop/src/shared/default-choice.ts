// The choice Connect makes for a person who asks nothing (desktop contract
// §8, and §10's cards): the quadit command and its skill (not MCP), the
// workspace at hand, an agent named after the tool (the one there already,
// when the workspace has it and the person may work as it), and no "without
// asking each time". The first run's cards and the Connect window's both
// connect with it; the Connect window's "More options" makes every choice.

import type { DesktopSummary } from "@/shared/bridge";
import type { ConnectChoice } from "@/shared/pages-api";

/** The default choice for connecting `tool` to the workspace `summary` describes, on the server `serverId`. */
export function defaultChoice(
  tool: { id: string; name: string },
  serverId: string,
  summary: Pick<DesktopSummary, "workspace" | "agents">,
): ConnectChoice {
  const handle = handleOf(tool.name);
  const agent = summary.agents.find((a) => a.handle === handle && a.usable);
  return {
    harness: tool.id,
    serverId,
    workspaceId: summary.workspace.id,
    methods: ["cli"],
    agent: agent ? { id: agent.id } : { create: { name: tool.name, handle } },
    allowUnattended: false,
  };
}

/** A tool's agent handle, from its name: "Claude Code" is @claude-code. */
export function handleOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
