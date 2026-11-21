import { describe, expect, it } from "vitest";
import { FirstConnect, type FirstConnectParts } from "@/main/first-connect";
import type { DesktopOutcome, DesktopRequest, DesktopSummary } from "@/shared/bridge";
import type { ConnectChoice, ConnectView, HarnessView, Planned, PlanView, Refused } from "@/shared/pages-api";

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
  warnings: [],
};

const SAMPLES_PATH: DesktopOutcome = { ok: true, path: "/personal/projects/GS" };

type Applied = { ok: true; hint: string; agent: { id: string; handle: string } | null } | Refused;

/** A promise and the function that settles it, for work a test holds until it lets it go. */
function held<T>(): { promise: Promise<T>; settle(value: T): void } {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (settle = done));
  return { promise, settle };
}

/**
 * A tools step for the workspace "personal" of the server "s1", over a
 * Connect that finds `harnesses`, whose plans answer `planned` one per ask
 * (then a plan p<n>) and whose Apply answers `applied` one per ask (then ok,
 * as the agent `agent-<n>`), each Apply first waiting for `applyWaits` when
 * given; the workspace's window shows it once `opensAfter` waits have
 * passed, and its page answers what it is asked with `answer`.
 */
function setUp({
  harnesses = [harness("claude", "Claude Code", { installed: true }), harness("codex", "Codex")],
  planned = [],
  applied = [],
  applyWaits = [],
  opensAfter = 0,
  agents = [],
  cliFound = true,
  defaultLogin = null,
  answer = SAMPLES_PATH,
  notes = [],
}: {
  harnesses?: HarnessView[];
  planned?: Planned[];
  applied?: Applied[];
  applyWaits?: Promise<void>[];
  opensAfter?: number;
  agents?: DesktopSummary["agents"];
  cliFound?: boolean;
  defaultLogin?: ConnectView["defaultLogin"];
  answer?: DesktopOutcome;
  notes?: string[];
} = {}) {
  const choices: ConnectChoice[] = [];
  const appliedIds: string[] = [];
  const disconnected: string[] = [];
  const asked: DesktopRequest[] = [];
  let waits = 0;
  let made = 0;
  let plans = 0;
  const parts: FirstConnectParts = {
    connections: {
      state: async () => ({
        supported: true,
        harnesses,
        cli: cliFound
          ? { found: "/usr/local/bin/quadit", version: "1.0.0", linkInto: null, profile: null, manual: null }
          : { found: null, version: "", linkInto: "~/.local/bin", profile: null, manual: null },
        defaultLogin,
        claudePlugin: false,
      }),
      planConnect: async (choice) => {
        choices.push(choice);
        plans++;
        return planned.shift() ?? { ok: true, plan: { ...PLAN, id: `p${plans}` } };
      },
      applyConnect: async (id) => {
        appliedIds.push(id);
        made++;
        const agent = `agent-${made}`;
        await applyWaits.shift();
        return applied.shift() ?? { ok: true, hint: "Start a new session.", agent: { id: agent, handle: agent } };
      },
      planDisconnect: (id) => ({ ok: true, plan: { ...PLAN, id: `undo-${id}` } }),
      applyDisconnect: async (planId) => {
        disconnected.push(planId);
        return { ok: true, notes };
      },
      dropPlans: () => {},
    },
    summaries: () => (waits >= opensAfter ? [{ serverId: "s1", summary: summary(agents), listening: true }] : []),
    ask: async (_serverId, _workspaceId, request) => {
      asked.push(request);
      return answer;
    },
    sleep: async () => void waits++,
  };
  const first = new FirstConnect(parts, "s1", "personal");
  return { first, choices, appliedIds, disconnected, asked, waits: () => waits };
}

describe("FirstConnect", () => {
  it("finds every tool Connect knows, saying which are on this computer and whom a tool on this computer's login works as, but leaves alone those connected before", async () => {
    const { first } = setUp({
      harnesses: [
        harness("claude", "Claude Code", { installed: true }),
        harness("codex", "Codex", {
          installed: true,
          connected: { methods: ["cli"], server: "x", workspace: "y", agent: "@codex" },
        }),
        harness("pi", "pi", { cliIdentity: "default" }),
      ],
      defaultLogin: { server: "https://q.example", agent: "@ann" },
    });
    expect(await first.look()).toEqual({
      tools: [
        { id: "claude", name: "Claude Code", initials: "Cl", found: true, ownLogin: true, worksAs: null },
        { id: "pi", name: "pi", initials: "pi", found: false, ownLogin: false, worksAs: "@ann on https://q.example" },
      ],
      addsCommand: false,
    });
  });

  it("says when connecting puts the quadit command on this computer too", async () => {
    const { first } = setUp({ cliFound: false });
    expect((await first.look()).addsCommand).toBe(true);
  });

  it("connects a tool found with the defaults, asking nothing, and says which agent of the workspace it works as", async () => {
    const { first, choices, appliedIds } = setUp();
    await first.look();
    expect(await first.connect("claude")).toEqual({ ok: true, agent: "agent-1" });
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

  it("connects with the plan the files sheet showed, and asks for another look when that plan is not the one kept", async () => {
    const { first, appliedIds, choices } = setUp();
    await first.look();
    const shown = await first.changes("claude");
    if (!shown.ok) throw new Error(shown.error);
    expect(await first.connect("claude", "another")).toMatchObject({ ok: false, stale: true });
    expect(appliedIds).toEqual([]);
    const again = await first.changes("claude");
    if (!again.ok) throw new Error(again.error);
    expect(await first.connect("claude", again.plan.id)).toMatchObject({ ok: true });
    // Applied as shown: no plan made anew for it.
    expect(appliedIds).toEqual([again.plan.id]);
    expect(choices).toHaveLength(2);
  });

  it("connects only a tool it found here", async () => {
    const { first, choices } = setUp();
    expect(await first.connect("claude")).toMatchObject({ ok: false });
    await first.look();
    expect(await first.connect("codex")).toMatchObject({ ok: false });
    expect(choices).toEqual([]);
  });

  it("waits for the workspace's window to show the workspace, and says so plainly when it does not", async () => {
    const slow = setUp({ opensAfter: 3 });
    await slow.first.look();
    expect(await slow.first.connect("claude")).toMatchObject({ ok: true });
    expect(slow.waits()).toBe(3);

    const never = setUp({ opensAfter: Number.POSITIVE_INFINITY });
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
    await first.look();
    expect(await first.connect("claude")).toEqual({
      ok: false,
      error: "/home/lou/.claude/settings.json is not valid JSON, so the app does not change it.",
    });
    expect(appliedIds).toEqual([]);
    expect(await first.connect("claude")).toMatchObject({ ok: true });
  });

  it("shows what connecting changes before, and after, what it did", async () => {
    const { first, appliedIds } = setUp();
    await first.look();
    expect(await first.changes("claude")).toMatchObject({ ok: true, plan: { id: "p1" } });
    expect(appliedIds).toEqual([]);
    await first.connect("claude");
    expect(await first.changes("claude")).toMatchObject({ ok: true, plan: { id: "p2" } });
  });

  it("takes a connection back with Undo, asking nothing, gives what the person should know, and only one it made", async () => {
    const note = "Revoke the token “Claude Code on mac” yourself in This computer's settings: it did not answer.";
    const { first, disconnected } = setUp({ notes: [note] });
    await first.look();
    expect(await first.disconnect("claude")).toMatchObject({ ok: false });
    await first.connect("claude");
    expect(await first.disconnect("claude")).toEqual({ ok: true, notes: [note] });
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
    await first.look();
    await first.connect("codex");
    await first.connect("claude");
    await first.connect("pi");
    await first.disconnect("codex");
    expect(await first.finish()).toEqual({ ok: true, path: "/personal/projects/GS" });
    // Codex was first, and was taken back: Claude Code, connected second, is the agent.
    expect(asked).toEqual([{ kind: "samples", agent: "agent-2" }]);
  });

  it("asks with no agent when no tool was connected, or when the one connected is no agent of this workspace", async () => {
    const skipped = setUp();
    await skipped.first.look();
    expect(skipped.first.samplesRequest()).toEqual({ kind: "samples" });

    // A tool on this computer's login, which is someone of another server: it works as that one, not as an agent here.
    const elsewhere = setUp({ applied: [{ ok: true, hint: "", agent: null }] });
    await elsewhere.first.look();
    expect(await elsewhere.first.connect("claude")).toEqual({ ok: true, agent: null });
    expect(elsewhere.first.samplesRequest()).toEqual({ kind: "samples" });
  });

  it("ends only after a Connect asked before it is done, and asks for the samples with that tool's agent", async () => {
    const apply = held<void>();
    const { first, asked } = setUp({ applyWaits: [apply.promise] });
    await first.look();
    const connecting = first.connect("claude");
    const finishing = first.finish();
    apply.settle();
    expect(await connecting).toMatchObject({ ok: true });
    expect(await finishing).toMatchObject({ ok: true });
    expect(asked).toEqual([{ kind: "samples", agent: "agent-1" }]);
  });

  it("ends only after an Undo asked before it is done, and asks without the agent taken back", async () => {
    const { first, asked } = setUp();
    await first.look();
    await first.connect("claude");
    const undoing = first.disconnect("claude");
    const finishing = first.finish();
    expect(await undoing).toMatchObject({ ok: true });
    expect(await finishing).toMatchObject({ ok: true });
    expect(asked).toEqual([{ kind: "samples" }]);
  });

  it("takes no Connect or Undo once the end has begun, and takes them again when it failed", async () => {
    const { first, appliedIds } = setUp({ answer: { ok: false, message: "The page does not take requests now." } });
    await first.look();
    const finishing = first.finish();
    expect(await first.connect("claude")).toEqual({ ok: false, error: "Quadit is opening your workspace." });
    expect(await first.disconnect("claude")).toEqual({ ok: false, error: "Quadit is opening your workspace." });
    expect(await finishing).toEqual({
      ok: false,
      error: "Your workspace did not answer: The page does not take requests now. Try again.",
    });
    expect(appliedIds).toEqual([]);
    expect(await first.connect("claude")).toMatchObject({ ok: true });
  });

  it("opens the workspace when its page answers without a path", async () => {
    const { first } = setUp({ answer: { ok: true } });
    expect(await first.finish()).toEqual({ ok: true, path: "/personal" });
  });
});
