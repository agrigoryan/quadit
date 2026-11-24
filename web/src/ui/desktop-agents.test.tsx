// @vitest-environment jsdom
// The desktop app's word on the agents this computer connects
// (ui/desktop-agents.ts): read through the bridge, and nothing at all, as in
// a browser, when there is no bridge, an older one without the call, or a
// call that fails. Opening the app's Connect window on one agent.

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import { WithQuery } from "@/test/query";
import type { Member, User, Workspace } from "@/types/core";
import type { QuaditDesktop } from "@/types/desktop";
import { canOpenConnect, type LocalAgent, openConnect, useLocalAgents } from "@/ui/desktop-agents";

const claude: LocalAgent = {
  agent: "a1",
  program: "claude",
  programName: "Claude Code",
  computer: "Aram's Mac",
  canRun: true,
  runs: [],
};

/** The app's bridge with the members given; `localAgents` is not in the shared type yet. */
const bridge = (more: Record<string, unknown> = {}) =>
  ({ version: "0.1.0", notify: () => {}, setBadge: () => {}, ...more }) as QuaditDesktop;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
  });
});

afterEach(() => {
  delete window.quaditDesktop;
});

const read = () => renderHook(() => useLocalAgents(), { wrapper: WithQuery }).result;

describe("useLocalAgents", () => {
  it("gives the agents the app connects on this computer, by agent id", async () => {
    window.quaditDesktop = bridge({ localAgents: () => Promise.resolve([claude]) });
    const result = read();
    await waitFor(() => expect(result.current).toEqual({ a1: claude }));
  });

  it("is null in a browser, in an app that cannot say, and when the app's call fails", async () => {
    expect(read().current).toBeNull();
    window.quaditDesktop = bridge({ openConnect: () => {} });
    expect(read().current).toBeNull();
    const failing = vi.fn().mockRejectedValue(new Error("no"));
    window.quaditDesktop = bridge({ localAgents: failing });
    const result = read();
    await waitFor(() => expect(failing).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 0));
    expect(result.current).toBeNull();
  });
});

describe("useLocalAgents, read again", () => {
  it("asks the app again when the window gets focus back or is shown again, as after a Disconnect in its Connect window", async () => {
    const ask = vi.fn().mockResolvedValue([claude]);
    window.quaditDesktop = bridge({ localAgents: ask });
    const result = read();
    await waitFor(() => expect(result.current).toEqual({ a1: claude }));
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockResolvedValue([]);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(result.current).toEqual({}));
    expect(ask).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
  });
});

describe("openConnect", () => {
  it("opens the app's Connect window on an agent, what to do for it and the program shown, or as it is without one", () => {
    const open = vi.fn();
    window.quaditDesktop = bridge({ openConnect: open });
    expect(canOpenConnect()).toBe(true);
    openConnect("a1", "run");
    openConnect("a1", "run", "codex");
    openConnect();
    expect(open.mock.calls).toEqual([
      [{ agent: "a1", intent: "run" }],
      [{ agent: "a1", intent: "run", program: "codex" }],
      [undefined],
    ]);
  });

  it("does nothing in a browser", () => {
    expect(canOpenConnect()).toBe(false);
    expect(() => openConnect("a1", "connect")).not.toThrow();
  });
});
