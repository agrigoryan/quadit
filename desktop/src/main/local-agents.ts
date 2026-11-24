// What a server's page is told of the tools on this computer that work as
// agents of its own workspace (the bridge's localAgents): for each, the
// agent, the tool, whether Run by Quadit is offered for it here, and the
// projects Quadit runs it for. Never a path, a token or a folder, and never
// another server's or workspace's tools.

import type { Connections } from "@/main/connections";
import type { Runner } from "@/main/runner";
import type { LocalAgent } from "@/shared/bridge";

/**
 * The LocalAgent list of the workspace `workspaceId` of the server `serverId`;
 * none when it cannot be told (a ledger that cannot be read), why kept in the
 * app's own log (`log`): an error names a path on this computer, never the
 * page's to know.
 */
export async function localAgents(
  parts: {
    connections: Pick<Connections, "agentsOf">;
    runner: Pick<Runner, "available" | "projectsOf">;
    log: (line: string) => void;
  },
  serverId: string,
  workspaceId: string,
): Promise<LocalAgent[]> {
  try {
    return await told(parts, serverId, workspaceId);
  } catch (error) {
    parts.log(`local agents: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function told(
  parts: { connections: Pick<Connections, "agentsOf">; runner: Pick<Runner, "available" | "projectsOf"> },
  serverId: string,
  workspaceId: string,
): Promise<LocalAgent[]> {
  const { connections, runner } = parts;
  return Promise.all(
    connections.agentsOf(serverId, workspaceId).map(async (tool) => {
      // A tool Quadit cannot run has no entries: its login matches none, and the computer's name is still said.
      const ran = await runner.projectsOf({
        login: tool.login ?? "",
        server: tool.origin,
        workspace: workspaceId,
        agent: tool.agent,
      });
      return {
        agent: tool.agent,
        program: tool.tool,
        programName: tool.name,
        computer: ran.machine,
        canRun: runner.available && tool.login !== null,
        runs: ran.projects,
      };
    }),
  );
}
