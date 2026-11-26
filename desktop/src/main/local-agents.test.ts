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
              {
                tool: "claude",
                name: "Claude Code",
                agent: "u2",
                origin: "https://q.example",
                login: "/h/Library/quadit/claude.json",
              },
              { tool: "pi", name: "pi", agent: "u3", origin: "https://q.example", login: null },
            ];
          },
        },
        runner: {
          available: true,
          projectsOf: async (of) => ({
            machine: "Aram's MacBook Pro",
            projects:
              of.login === "/h/Library/quadit/claude.json" && of.server === "https://q.example" && of.workspace === "w1"
                ? ["p-sva"]
                : [],
          }),
        },
        log: () => {},
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
        connections: {
          agentsOf: () => [
            { tool: "claude", name: "Claude Code", agent: "u2", origin: "https://q.example", login: "/x.json" },
          ],
        },
        runner: { available: false, projectsOf: async () => ({ machine: "", projects: [] }) },
        log: () => {},
      },
      "s1",
      "w1",
    );
    expect(agents[0]).toMatchObject({ canRun: false, computer: "", runs: [] });
  });

  it("answers nothing when the ledger cannot be read, and keeps why in the app's own log, never telling the page", async () => {
    const logged: string[] = [];
    const agents = await localAgents(
      {
        connections: {
          agentsOf: () => {
            throw new Error("/Users/maya/Library/Application Support/Quadit/connections.json cannot be read");
          },
        },
        runner: { available: true, projectsOf: async () => ({ machine: "", projects: [] }) },
        log: (line) => void logged.push(line),
      },
      "s1",
      "w1",
    );
    expect(agents).toEqual([]);
    expect(logged).toEqual([
      "local agents: /Users/maya/Library/Application Support/Quadit/connections.json cannot be read",
    ]);
  });
});
