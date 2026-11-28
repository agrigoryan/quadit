import { describe, expect, it } from "vitest";
import { FirstConnect, type FirstConnectParts } from "@/main/first-connect";
import type { Answer } from "@/main/requests";
import type { DesktopRequest, DesktopSummary } from "@/shared/bridge";
import type {
  ConnectChoice,
  ConnectionRef,
  ConnectionView,
  ConnectView,
  HarnessView,
  Planned,
  PlanView,
  Refused,
  Unrevoked,
} from "@/shared/pages-api";

function harness(id: string, name: string, extra: Partial<HarnessView> = {}): HarnessView {
  return {
    id,
    name,
    initials: name.slice(0, 2),
    installed: false,
    unavailable: null,
    mcp: true,
    cliIdentity: "own",
    listenVerified: true,
    skillChangedByHand: false,
    allows: false,
    connected: null,
    elsewhere: [],
    ...extra,
  };
}

/** A tool's connection in the workspace `workspace`, as Connect agents sees it. */
function connection(tool: string, workspace: string): ConnectionView {
  return {
    ref: { tool, serverId: "s0", workspaceId: workspace, agentId: `as-${tool}` },
    methods: ["cli"],
    server: "x",
    workspace,
    agent: `@${tool}`,
    folders: [],
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

const SAMPLES_PATH: Answer = { ok: true, path: "/personal/projects/GS" };

type Applied =
  | {
      ok: true;
      hint: string;
      agent: { id: string; handle: string } | null;
      connection: { ref: ConnectionRef; workspace: string };
      added: boolean;
    }
  | Refused;

/** The connection a Connect made, in the workspace the step is for. */
const MADE = {
  ref: { tool: "claude", serverId: "s1", workspaceId: "w1", agentId: "as-claude" },
  workspace: "Personal",
};

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
  defaultLogin = [],
  answer = SAMPLES_PATH,
  unrevoked = null,
}: {
  harnesses?: HarnessView[];
  planned?: Planned[];
  applied?: Applied[];
  applyWaits?: Promise<void>[];
  opensAfter?: number;
  agents?: DesktopSummary["agents"];
  cliFound?: boolean;
  defaultLogin?: ConnectView["defaultLogin"];
  answer?: Answer;
  unrevoked?: Unrevoked | null;
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
        at: null,
        harnesses,
        cli: cliFound
          ? {
              found: "/usr/local/bin/quadit",
              version: "1.0.0",
              linkInto: null,
              profile: null,
              pathFolder: null,
              manual: null,
            }
          : { found: null, version: "", linkInto: "~/.local/bin", profile: null, pathFolder: null, manual: null },
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
        return (
          applied.shift() ?? {
            ok: true,
            hint: "Start a new session.",
            agent: { id: agent, handle: agent },
            connection: {
              ref: { tool: "t", serverId: "s1", workspaceId: "w1", agentId: agent },
              workspace: "Personal",
            },
            added: false,
          }
        );
      },
      planDisconnect: async (ref) => ({ ok: true, plan: { ...PLAN, id: `undo-${ref.agentId}` } }),
      applyDisconnect: async (planId) => {
        disconnected.push(planId);
        return { ok: true, notes: [], unrevoked };
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
  const paths: string[] = [];
  const finish = () =>
    first.finish(async (path) => {
      paths.push(path);
      return true;
    });
  return { first, finish, paths, choices, appliedIds, disconnected, asked, waits: () => waits };
}

describe("FirstConnect", () => {
  it("finds every tool Connect knows, saying which are on this computer, whom a tool on this computer's login works as and whether its listening was verified, but leaves alone those connected before", async () => {
    const { first } = setUp({
      harnesses: [
        harness("claude", "Claude Code", { installed: true, chatListens: "background" }),
        harness("codex", "Codex", { installed: true, connected: connection("codex", "y") }),
        // Connected in another workspace only: left alone too (Connect agents offers to connect it here as well).
        harness("gemini", "Gemini CLI", { installed: true, elsewhere: [connection("gemini", "z")] }),
        harness("pi", "pi", { cliIdentity: "default", listenVerified: false }),
      ],
      defaultLogin: [{ server: "https://q.example", agent: "@ann", workspaceId: "w0" }],
    });
    expect(await first.look()).toEqual({
      tools: [
        {
          id: "claude",
          name: "Claude Code",
          initials: "Cl",
          found: true,
          ownLogin: true,
          worksAs: null,
          listenVerified: true,
          chatListens: "background",
          allows: false,
        },
        {
          id: "pi",
          name: "pi",
          initials: "pi",
          found: false,
          ownLogin: false,
          worksAs: "@ann on https://q.example",
          listenVerified: false,
          allows: false,
        },
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
    expect(await first.connect("claude")).toMatchObject({
      ok: true,
      agent: "agent-1",
      connection: { workspace: "Personal" },
    });
    expect(choices).toEqual([
      {
        harness: "claude",
        serverId: "s1",
        workspaceId: "w1",
        methods: ["cli"],
        agent: { create: { name: "Claude Code", handle: "claude-code" } },
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
    const unrevoked = {
      label: "Claude Code on mac",
      agent: "claude-code",
      workspace: "Personal",
      server: "This computer",
      reason: "No.",
    };
    const { first, disconnected } = setUp({ unrevoked });
    await first.look();
    expect(await first.disconnect("claude")).toMatchObject({ ok: false });
    await first.connect("claude");
    expect(await first.disconnect("claude")).toEqual({ ok: true, notes: [], unrevoked });
    expect(disconnected).toEqual(["undo-agent-1"]);
  });

  it("ends by asking the workspace's page for the samples, the third task for the first tool connected that still is", async () => {
    const { first, finish, paths, asked } = setUp({
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
    expect(await finish()).toEqual({ ok: true });
    expect(paths).toEqual(["/personal/projects/GS"]);
    // Codex was first, and was taken back: Claude Code, connected second, is the agent.
    expect(asked).toEqual([{ kind: "samples", agent: "agent-2" }]);
  });

  it("asks with no agent when no tool was connected, or when the one connected is no agent of this workspace", async () => {
    const skipped = setUp();
    await skipped.first.look();
    expect(skipped.first.samplesRequest()).toEqual({ kind: "samples" });

    // A tool on this computer's login, which is someone of another server: it works as that one, not as an agent here.
    const elsewhere = setUp({ applied: [{ ok: true, hint: "", agent: null, connection: MADE, added: false }] });
    await elsewhere.first.look();
    expect(await elsewhere.first.connect("claude")).toEqual({ ok: true, agent: null, connection: MADE });
    expect(elsewhere.first.samplesRequest()).toEqual({ kind: "samples" });
  });

  it("ends only after a Connect asked before it is done, and asks for the samples with that tool's agent", async () => {
    const apply = held<void>();
    const { first, finish, asked } = setUp({ applyWaits: [apply.promise] });
    await first.look();
    const connecting = first.connect("claude");
    const finishing = finish();
    apply.settle();
    expect(await connecting).toMatchObject({ ok: true });
    expect(await finishing).toMatchObject({ ok: true });
    expect(asked).toEqual([{ kind: "samples", agent: "agent-1" }]);
  });

  it("ends only after an Undo asked before it is done, and asks without the agent taken back", async () => {
    const { first, finish, asked } = setUp();
    await first.look();
    await first.connect("claude");
    const undoing = first.disconnect("claude");
    const finishing = finish();
    expect(await undoing).toMatchObject({ ok: true });
    expect(await finishing).toMatchObject({ ok: true });
    expect(asked).toEqual([{ kind: "samples" }]);
  });

  it("takes no Connect or Undo once the end has begun, and takes them again when it failed", async () => {
    const { first, finish, appliedIds } = setUp({
      answer: { ok: false, message: "The sample assignment was refused" },
    });
    await first.look();
    const finishing = finish();
    expect(await first.connect("claude")).toEqual({ ok: false, error: "Quadit is opening your workspace." });
    expect(await first.disconnect("claude")).toEqual({ ok: false, error: "Quadit is opening your workspace." });
    expect(await finishing).toEqual({
      ok: false,
      error: "Your workspace said no to the sample tasks: The sample assignment was refused.",
    });
    expect(appliedIds).toEqual([]);
    expect(await first.connect("claude")).toMatchObject({ ok: true });
  });

  it("says no answer apart from a refusal, and a page that did not open apart from both, in one sentence each", async () => {
    const silent = setUp({
      answer: { ok: false, message: "The server's page did not answer in time.", unanswered: true },
    });
    expect(await silent.finish()).toEqual({
      ok: false,
      error: "Quadit could not reach your workspace to set up the sample tasks.",
    });
    const unopened = setUp();
    expect(await unopened.first.finish(async () => false)).toEqual({
      ok: false,
      error: "The sample tasks are ready, but their page did not open.",
    });
    const neverShown = setUp({ opensAfter: Number.POSITIVE_INFINITY });
    expect(await neverShown.finish()).toEqual({
      ok: false,
      error: "Quadit could not reach your workspace to set up the sample tasks.",
    });
  });

  it("keeps the tools step usable when the workspace could not navigate", async () => {
    const { first, finish } = setUp();
    await first.look();
    expect(await first.finish(async () => false)).toMatchObject({ ok: false });
    expect(await first.connect("claude")).toMatchObject({ ok: true });
    expect(await finish()).toEqual({ ok: true });
  });

  it("opens the workspace when its page answers without a path", async () => {
    const { finish, paths } = setUp({ answer: { ok: true } });
    expect(await finish()).toEqual({ ok: true });
    expect(paths).toEqual(["/personal"]);
  });
});
