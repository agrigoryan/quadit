import { describe, expect, it } from "vitest";
import { FirstConnect, type FirstConnectParts } from "@/main/first-connect";
import type { DesktopSummary } from "@/shared/bridge";
import type { ConnectChoice, HarnessView, Planned, PlanView } from "@/shared/pages-api";

function harness(id: string, name: string, extra: Partial<HarnessView> = {}): HarnessView {
  return { id, name, installed: false, mcp: true, cliIdentity: "own", connected: null, ...extra };
}

function summary(agents: DesktopSummary["agents"] = []): DesktopSummary {
  return {
    workspace: { id: "w1", slug: "personal", name: "Personal" },
    me: { name: "Lou", canCreateAgents: true },
    waiting: [],
    agents,
    projects: [],
  };
}

const PLAN: PlanView = {
  id: "p1",
  files: [{ path: "/home/lou/.claude/settings.json", diff: "+x" }],
  backupDir: "/b",
  warnings: [],
};

/**
 * A FirstConnect over a Connect that finds `harnesses`, whose plans answer
 * `planned` one per ask (then PLAN) and whose Apply answers `applied` one
 * per ask (then ok); the workspace's window shows it once `opensAfter`
 * waits have passed.
 */
function setUp({
  harnesses = [harness("claude", "Claude Code", { installed: true }), harness("codex", "Codex")],
  planned = [] as Planned[],
  applied = [] as ({ ok: true; hint: string } | { ok: false; error: string })[],
  opensAfter = 0,
  agents = [] as DesktopSummary["agents"],
} = {}) {
  const choices: ConnectChoice[] = [];
  const appliedIds: string[] = [];
  let dropped = 0;
  let waits = 0;
  const parts: FirstConnectParts = {
    connections: {
      state: async () => ({
        supported: true,
        harnesses,
        cli: { found: "/usr/local/bin/quadit", version: "1.0.0", linkInto: null, profile: null, manual: null },
        defaultLogin: null,
        claudePlugin: false,
      }),
      planConnect: async (choice) => {
        choices.push(choice);
        return planned.shift() ?? { ok: true, plan: PLAN };
      },
      applyConnect: async (id) => {
        appliedIds.push(id);
        return applied.shift() ?? { ok: true, hint: "Start a new Claude Code session." };
      },
      dropPlans: () => void dropped++,
    },
    summaries: () => (waits >= opensAfter ? [{ serverId: "s1", summary: summary(agents), listening: true }] : []),
    sleep: async () => void waits++,
  };
  return { first: new FirstConnect(parts), choices, appliedIds, dropped: () => dropped, waits: () => waits };
}

describe("FirstConnect", () => {
  it("offers the tools found on this computer and not connected yet; with none, there is no step", async () => {
    const { first } = setUp({
      harnesses: [
        harness("claude", "Claude Code", { installed: true }),
        harness("codex", "Codex", {
          installed: true,
          connected: { methods: ["cli"], server: "x", workspace: "y", agent: "@codex" },
        }),
        harness("gemini", "Gemini CLI"),
      ],
    });
    expect(await first.begin("s1", "personal")).toEqual([{ id: "claude", name: "Claude Code" }]);
    expect(await setUp({ harnesses: [harness("claude", "Claude Code")] }).first.begin("s1", "personal")).toEqual([]);
  });

  it("connects a tool with the defaults, asking nothing: the command and its skill, the new workspace, a new agent named after the tool", async () => {
    const { first, choices, appliedIds } = setUp();
    await first.begin("s1", "personal");
    expect(await first.connect("claude")).toEqual({ ok: true });
    expect(choices).toEqual([
      {
        harness: "claude",
        serverId: "s1",
        workspaceId: "w1",
        methods: ["cli"],
        agent: { create: { name: "Claude Code", handle: "claude-code" } },
        allowUnattended: false,
      },
    ]);
    expect(appliedIds).toEqual(["p1"]);
  });

  it("works as the tool's agent when the workspace has it already", async () => {
    const agent = {
      id: "u7",
      handle: "claude-code",
      name: "Claude Code",
      state: "idle" as const,
      detail: "",
      path: "/",
      usable: true,
    };
    const { first, choices } = setUp({ agents: [agent] });
    await first.begin("s1", "personal");
    await first.connect("claude");
    expect(choices[0]?.agent).toEqual({ id: "u7" });
  });

  it("waits for the workspace's window to show the workspace, and says so plainly when it does not", async () => {
    const slow = setUp({ opensAfter: 3 });
    await slow.first.begin("s1", "personal");
    expect(await slow.first.connect("claude")).toEqual({ ok: true });
    expect(slow.waits()).toBe(3);

    const never = setUp({ opensAfter: Number.POSITIVE_INFINITY });
    await never.first.begin("s1", "personal");
    expect(await never.first.connect("claude")).toEqual({
      ok: false,
      error: "Your workspace's window has not finished opening. Try again in a moment.",
    });
  });

  it("gives Connect's refusal plainly, and connects on trying again", async () => {
    const { first, appliedIds } = setUp({
      planned: [
        { ok: false, error: "/home/lou/.claude/settings.json is not valid JSON, so the app does not change it." },
      ],
      applied: [],
    });
    await first.begin("s1", "personal");
    expect(await first.connect("claude")).toEqual({
      ok: false,
      error: "/home/lou/.claude/settings.json is not valid JSON, so the app does not change it.",
    });
    expect(appliedIds).toEqual([]);
    expect(await first.connect("claude")).toEqual({ ok: true });

    const failing = setUp({ applied: [{ ok: false, error: "No token was made." }] });
    await failing.first.begin("s1", "personal");
    expect(await failing.first.connect("claude")).toEqual({ ok: false, error: "No token was made." });
  });

  it("shows what connecting changes before, without keeping the plan, and after, what it did", async () => {
    const { first, appliedIds, dropped } = setUp({
      planned: [
        { ok: true, plan: PLAN },
        { ok: true, plan: { ...PLAN, id: "p2" } },
      ],
    });
    await first.begin("s1", "personal");
    expect(await first.changes("claude")).toEqual({ ok: true, plan: PLAN });
    expect(dropped()).toBe(1);
    expect(appliedIds).toEqual([]);
    await first.connect("claude");
    expect(await first.changes("claude")).toEqual({ ok: true, plan: { ...PLAN, id: "p2" } });
  });

  it("connects only a tool it offered, and nothing once the step is over (skipped or done)", async () => {
    const { first, choices } = setUp();
    expect(await first.connect("claude")).toMatchObject({ ok: false });
    await first.begin("s1", "personal");
    expect(await first.connect("codex")).toMatchObject({ ok: false });
    first.end();
    expect(await first.connect("claude")).toMatchObject({ ok: false });
    expect(choices).toEqual([]);
  });
});
