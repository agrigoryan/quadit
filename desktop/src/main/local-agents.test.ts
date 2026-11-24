import { describe, expect, it } from "vitest";
import { localAgents } from "@/main/local-agents";

describe("localAgents", () => {
  it("tells a page of its workspace's agents on this computer, and of nothing on the computer's files", async () => {
    const asked: string[] = [];
    const agents = await localAgents(
      {
        connections: {
          agentsOf: (serverId, workspaceId) => {
            asked.push(`${serverId}/${workspaceId}`);
            return [
              { tool: "claude", name: "Claude Code", agent: "u2", login: "/h/Library/quadit/claude.json" },
              { tool: "pi", name: "pi", agent: "u3", login: null },
            ];
          },
        },
        runner: {
          available: true,
          projectsOf: async (login) => ({
            machine: "Aram's MacBook Pro",
            projects: login === "/h/Library/quadit/claude.json" ? ["p-sva"] : [],
          }),
        },
      },
      "s1",
      "w1",
    );
    expect(asked).toEqual(["s1/w1"]);
    expect(agents).toEqual([
      {
        agent: "u2",
        program: "claude",
        programName: "Claude Code",
        computer: "Aram's MacBook Pro",
        canRun: true,
        runs: ["p-sva"],
      },
      { agent: "u3", program: "pi", programName: "pi", computer: "Aram's MacBook Pro", canRun: false, runs: [] },
    ]);
    // No path of the computer's in what a page is told.
    expect(JSON.stringify(agents)).not.toContain("/");
  });

  it("offers no run where the app carries no quadit", async () => {
    const agents = await localAgents(
      {
        connections: { agentsOf: () => [{ tool: "claude", name: "Claude Code", agent: "u2", login: "/x.json" }] },
        runner: { available: false, projectsOf: async () => ({ machine: "", projects: [] }) },
      },
      "s1",
      "w1",
    );
    expect(agents[0]).toMatchObject({ canRun: false, computer: "", runs: [] });
  });
});
