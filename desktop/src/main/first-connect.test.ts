import { describe, expect, it } from "vitest";
import { FirstConnect, type FirstConnectParts } from "@/main/first-connect";
import type { DesktopOutcome, DesktopRequest, DesktopSummary } from "@/shared/bridge";
import type { ConnectChoice, HarnessView, Planned, PlanView } from "@/shared/pages-api";

function harness(id: string, name: string, extra: Partial<HarnessView> = {}): HarnessView {
  return {
    id,
    name,
    initials: name.slice(0, 2),
    installed: false,
    mcp: true,
    cliIdentity: "own",
    connected: null,
    ...extra,
  };
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
  files: [
    {
      path: "/home/lou/.claude/settings.json",
      shown: "~/.claude/settings.json",
      role: "settings",
      change: "edited",
      diff: "+x",
    },
  ],
  backupDir: "/b",
  warnings: [],
};

const SAMPLES_PATH: DesktopOutcome = { ok: true, path: "/personal/projects/GS" };

type Applied = { ok: true; hint: string; agent: { id: string; handle: string } | null } | { ok: false; error: string };

/**
 * A FirstConnect over a Connect that finds `harnesses`, whose plans answer
 * `planned` one per ask (then PLAN) and whose Apply answers `applied` one
 * per ask (then ok, as the agent `agent-<n>`); the workspace's window shows
 * it once `opensAfter` waits have passed, and its page answers what it is
 * asked with `answer`.
 */
function setUp({
  harnesses = [harness("claude", "Claude Code", { installed: true }), harness("codex", "Codex")],
  planned = [],
  applied = [],
  opensAfter = 0,
  agents = [],
  cliFound = true,
  answer = SAMPLES_PATH,
}: {
  harnesses?: HarnessView[];
  planned?: Planned[];
  applied?: Applied[];
  opensAfter?: number;
  agents?: DesktopSummary["agents"];
  cliFound?: boolean;
  answer?: DesktopOutcome;
} = {}) {
  const choices: ConnectChoice[] = [];
  const appliedIds: string[] = [];
  const disconnected: string[] = [];
  const asked: DesktopRequest[] = [];
  let dropped = 0;
  let waits = 0;
  let made = 0;
  const parts: FirstConnectParts = {
    connections: {
      state: async () => ({
        supported: true,
        harnesses,
        cli: cliFound
          ? { found: "/usr/local/bin/quadit", version: "1.0.0", linkInto: null, profile: null, manual: null }
          : { found: null, version: "", linkInto: "~/.local/bin", profile: null, manual: null },
        defaultLogin: null,
        claudePlugin: false,
      }),
      planConnect: async (choice) => {
        choices.push(choice);
        return planned.shift() ?? { ok: true, plan: PLAN };
      },
      applyConnect: async (id) => {
        appliedIds.push(id);
        made++;
        return (
          applied.shift() ?? { ok: true, hint: "Start a new session.", agent: { id: `agent-${made}`, handle: "x" } }
        );
      },
      planDisconnect: (id) => ({ ok: true, plan: { ...PLAN, id: `undo-${id}` } }),
      applyDisconnect: async (planId) => {
        disconnected.push(planId);
        return { ok: true, notes: [] };
      },
      dropPlans: () => void dropped++,
    },
    summaries: () => (waits >= opensAfter ? [{ serverId: "s1", summary: summary(agents), listening: true }] : []),
    ask: async (_serverId, _workspaceId, request) => {
      asked.push(request);
      return answer;
    },
    sleep: async () => void waits++,
  };
  return {
    first: new FirstConnect(parts),
    choices,
    appliedIds,
    disconnected,
    asked,
    dropped: () => dropped,
    waits: () => waits,
  };
}

describe("FirstConnect", () => {
  it("finds every tool Connect knows, saying which are on this computer, but leaves alone those connected before", async () => {
    const { first } = setUp({
      harnesses: [
        harness("claude", "Claude Code", { installed: true }),
        harness("codex", "Codex", {
          installed: true,
          connected: { methods: ["cli"], server: "x", workspace: "y", agent: "@codex" },
        }),
        harness("pi", "pi", { cliIdentity: "default" }),
      ],
    });
    first.begin("s1", "personal");
    expect(await first.look()).toEqual({
      tools: [
        { id: "claude", name: "Claude Code", initials: "Cl", found: true, ownLogin: true },
        { id: "pi", name: "pi", initials: "pi", found: false, ownLogin: false },
      ],
      addsCommand: false,
    });
  });

  it("says when connecting puts the quadit command on this computer too", async () => {
    const { first } = setUp({ cliFound: false });
    first.begin("s1", "personal");
    expect((await first.look()).addsCommand).toBe(true);
  });

  it("connects a tool found with the defaults, asking nothing: the command and its skill, the new workspace, a new agent named after the tool", async () => {
    const { first, choices, appliedIds } = setUp();
    first.begin("s1", "personal");
    await first.look();
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

  it("connects only a tool it found here, and nothing once the step is over (skipped or done)", async () => {
    const { first, choices } = setUp();
    first.begin("s1", "personal");
    expect(await first.connect("claude")).toMatchObject({ ok: false });
    await first.look();
    expect(await first.connect("codex")).toMatchObject({ ok: false });
    first.end();
    expect(await first.connect("claude")).toMatchObject({ ok: false });
    expect(choices).toEqual([]);
  });

  it("waits for the workspace's window to show the workspace, and says so plainly when it does not", async () => {
    const slow = setUp({ opensAfter: 3 });
    slow.first.begin("s1", "personal");
    await slow.first.look();
    expect(await slow.first.connect("claude")).toEqual({ ok: true });
    expect(slow.waits()).toBe(3);

    const never = setUp({ opensAfter: Number.POSITIVE_INFINITY });
    never.first.begin("s1", "personal");
    await never.first.look();
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
    });
    first.begin("s1", "personal");
    await first.look();
    expect(await first.connect("claude")).toEqual({
      ok: false,
      error: "/home/lou/.claude/settings.json is not valid JSON, so the app does not change it.",
    });
    expect(appliedIds).toEqual([]);
    expect(await first.connect("claude")).toEqual({ ok: true });
  });

  it("shows what connecting changes before, without keeping the plan, and after, what it did", async () => {
    const { first, appliedIds, dropped } = setUp({
      planned: [
        { ok: true, plan: PLAN },
        { ok: true, plan: { ...PLAN, id: "p2" } },
      ],
    });
    first.begin("s1", "personal");
    await first.look();
    expect(await first.changes("claude")).toEqual({ ok: true, plan: PLAN });
    expect(dropped()).toBe(1);
    expect(appliedIds).toEqual([]);
    await first.connect("claude");
    expect(await first.changes("claude")).toEqual({ ok: true, plan: { ...PLAN, id: "p2" } });
  });

  it("takes a connection back with Undo, asking nothing, and only one it made", async () => {
    const { first, disconnected } = setUp();
    first.begin("s1", "personal");
    await first.look();
    expect(await first.disconnect("claude")).toMatchObject({ ok: false });
    await first.connect("claude");
    expect(await first.disconnect("claude")).toEqual({ ok: true });
    expect(disconnected).toEqual(["undo-claude"]);
  });

  it("ends by asking the workspace's page for the samples, the third task for the first tool connected that still is", async () => {
    const { first, asked } = setUp({
      harnesses: [
        harness("claude", "Claude Code", { installed: true }),
        harness("codex", "Codex", { installed: true }),
        harness("pi", "pi", { installed: true }),
      ],
    });
    first.begin("s1", "personal");
    await first.look();
    await first.connect("codex");
    await first.connect("claude");
    await first.connect("pi");
    await first.disconnect("codex");
    expect(await first.finish()).toBe("/personal/projects/GS");
    // Codex was first, and was taken back: Claude Code, connected second, is the agent.
    expect(asked).toEqual([{ kind: "samples", agent: "agent-2" }]);
  });

  it("asks for the samples with no agent when no tool was connected, or when the one connected has none here", async () => {
    const skipped = setUp();
    skipped.first.begin("s1", "personal");
    await skipped.first.look();
    expect(skipped.first.samplesRequest()).toEqual({ kind: "samples" });

    const noAgent = setUp({ applied: [{ ok: true, hint: "", agent: null }] });
    noAgent.first.begin("s1", "personal");
    await noAgent.first.look();
    await noAgent.first.connect("claude");
    expect(noAgent.first.samplesRequest()).toEqual({ kind: "samples" });
  });

  it("gives no path when the page cannot make the samples, and none once the step is over", async () => {
    const refused = setUp({ answer: { ok: false, message: "The page does not take requests now." } });
    refused.first.begin("s1", null);
    expect(await refused.first.finish()).toBeNull();
    refused.first.end();
    expect(await refused.first.finish()).toBeNull();
    expect(refused.asked).toEqual([{ kind: "samples" }]);
  });
});
