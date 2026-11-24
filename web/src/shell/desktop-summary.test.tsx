// @vitest-environment jsdom
// What the desktop app is told about the workspace a window shows
// (shell/desktop-summary.ts): the questions waiting on me with their
// options, the agents and which I may connect, the projects I may make a
// task in; and nothing once the shell goes.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "@/types/dashboard";
import { clearStore, loadBootstrap, mergeRows, patchRow } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import type { QuaditDesktop } from "@/types/desktop";

// As GET /agents gives them: the handle with its "@".
const agentStates: Record<string, AgentState> = {
  a1: {
    handle: "@claude",
    name: "Claude",
    user_id: "a1",
    state: "working",
    task: "SVA-5",
    doing: "tuning",
    listening: true,
    listeners: [{ live: true, by: "a chat" }],
    listening_projects: ["p1"],
    listening_outside_projects: true,
    open_tasks: 1,
    waiting_on_it: 0,
  },
  a2: {
    handle: "@codex",
    name: "Codex",
    user_id: "a2",
    state: "idle",
    listening: false,
    listeners: [],
    listening_projects: [],
    listening_outside_projects: false,
    open_tasks: 0,
    waiting_on_it: 0,
  },
};
vi.mock("@/data/listening", () => ({ useAgentStates: () => ({ data: agentStates, error: "" }) }));

const { useDesktopSummary, useSummary } = await import("@/shell/desktop-summary");

function load(role: Member["role"], scope?: Member["scope"]) {
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1", role, scope, name: "Ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [
      { user_id: "u1", name: "Ann", handle: "ann", kind: "person" },
      { user_id: "a1", name: "Claude", handle: "claude", kind: "agent", responsible_id: "u1" },
      { user_id: "a2", name: "Codex", handle: "codex", kind: "agent", responsible_id: "u2" },
    ] as Member[],
    projects: [
      { id: "p1", key: "SVA", name: "Samurai", rank: "a" },
      { id: "p2", key: "OPS", name: "Operations", rank: "b" },
    ],
    tasks: [{ id: "t1", key: "SVA-5", title: "Jump feels floaty", project_id: "p1" }],
    decisions: [
      {
        id: "d1",
        task_id: "t1",
        kind: "choice",
        question: "Which jump?",
        state: "open",
        asked_id: "u1",
        created_at: 1,
        options: [
          { id: "o1", decision_id: "d1", label: "Higher", rank: "a" },
          {
            id: "o2",
            decision_id: "d1",
            label: "A label far longer than the forty characters a button has",
            rank: "b",
          },
        ],
      },
      {
        id: "d2",
        task_id: "t1",
        kind: "choice",
        question: "Asked of Bea",
        state: "open",
        asked_id: "u2",
        created_at: 2,
      },
      { id: "d3", task_id: "t1", kind: "approval", question: "Ship it?", state: "open", asked_id: "u1", created_at: 3 },
    ],
  });
}

afterEach(() => {
  cleanup();
  delete window.quaditDesktop;
  clearStore();
});

describe("the summary", () => {
  it("lists the questions waiting on me, newest first, each option a button", () => {
    load("member");
    const { result } = renderHook(() => useSummary());
    expect(result.current?.workspace).toEqual({ id: "w", slug: "acme", name: "Acme" });
    expect(result.current?.waiting).toEqual([
      { title: "Ship it?", detail: "SVA-5 Jump feels floaty", path: "/acme/task/SVA-5#decision-d3", actions: [] },
      {
        title: "Which jump?",
        detail: "SVA-5 Jump feels floaty",
        path: "/acme/task/SVA-5#decision-d1",
        actions: [
          { label: "Higher", request: "pick:d1:o1" },
          { label: "A label far longer than the forty charac", request: "pick:d1:o2" },
        ],
      },
    ]);
  });

  it("lists the agents with what each is doing, usable where I answer for it", () => {
    load("member");
    const { result } = renderHook(() => useSummary());
    expect(result.current?.agents).toEqual([
      {
        id: "a1",
        handle: "claude",
        name: "Claude",
        state: "working",
        detail: "SVA-5 tuning",
        path: "/acme/task/SVA-5",
        usable: true,
      },
      {
        id: "a2",
        handle: "codex",
        name: "Codex",
        state: "idle",
        detail: "Nothing assigned",
        path: "/acme/agents",
        usable: false,
      },
    ]);
    expect(result.current?.me).toEqual({ name: "Ann", canCreateAgents: false });
  });

  it("lets an admin use every agent and make new ones", () => {
    load("admin");
    const { result } = renderHook(() => useSummary());
    expect(result.current?.agents.map((a) => a.usable)).toEqual([true, true]);
    expect(result.current?.me.canCreateAgents).toBe(true);
  });

  it("offers a newly created agent before the next activity read, and drops suspended agents immediately", () => {
    load("member");
    const { result } = renderHook(() => useSummary());
    act(() => {
      mergeRows("members", [
        { user_id: "a3", name: "Claude Code", handle: "claude-code", kind: "agent", responsible_id: "u1" } as Member,
      ]);
      patchRow("members", "a1", { suspended_at: 1 });
    });
    expect(result.current?.agents.map(({ handle, usable }) => [handle, usable])).toEqual([
      ["claude-code", true],
      ["codex", false],
    ]);
  });

  it("offers only the projects I may make a task in", () => {
    load("member", { projects: ["p2"] });
    const { result } = renderHook(() => useSummary());
    expect(result.current?.projects).toEqual([{ key: "OPS", name: "Operations" }]);
  });
});

describe("in the desktop app", () => {
  let publish: ReturnType<typeof vi.fn<NonNullable<QuaditDesktop["publish"]>>>;
  beforeEach(() => {
    publish = vi.fn();
    window.quaditDesktop = { version: "0.1.0", notify: vi.fn(), setBadge: vi.fn(), publish, onRequest: vi.fn() };
    load("member");
  });

  it("is told again only when the summary changes, and told nothing once the shell goes", () => {
    const { unmount } = renderHook(() => useDesktopSummary());
    expect(publish).toHaveBeenCalledTimes(1);
    act(() => patchRow("tasks", "t1", { priority: 1 }));
    expect(publish).toHaveBeenCalledTimes(1);
    act(() => patchRow("decisions", "d1", { state: "picked" }));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.lastCall?.[0]?.waiting.map((w) => w.title)).toEqual(["Ship it?"]);
    unmount();
    expect(publish).toHaveBeenLastCalledWith(null);
  });
});
