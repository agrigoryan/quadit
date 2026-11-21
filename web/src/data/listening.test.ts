// How far an agent is connected (data/listening.ts connectionOf): listening
// while the server says so, connected once it proved it reached Quadit
// (its row, which the feed keeps current, or the server's reading), and not
// connected yet otherwise.

import { describe, expect, it } from "vitest";
import { connectionOf } from "@/data/listening";
import type { Member } from "@/types/core";
import type { AgentState } from "@/types/dashboard";

const agent = { user_id: "a1", handle: "codex", name: "Codex", kind: "agent" } as Member;
const state = (more: Partial<AgentState>): AgentState => ({
  user_id: "a1",
  handle: "@codex",
  name: "Codex",
  state: "idle",
  listening: false,
  open_tasks: 0,
  waiting_on_it: 0,
  ...more,
});

describe("connectionOf", () => {
  it("is listening while the server says its listener holds the lease", () => {
    expect(connectionOf(agent, state({ listening: true }))).toBe("listening");
  });

  it("is connected once its row or the server says it proved it", () => {
    expect(connectionOf({ ...agent, connected_at: 1 }, state({}))).toBe("connected");
    expect(connectionOf(agent, state({ connected_at: "2026-11-21 14:02" }))).toBe("connected");
    expect(connectionOf({ ...agent, connected_at: 1 }, undefined)).toBe("connected");
  });

  it("is not connected yet otherwise", () => {
    expect(connectionOf(agent, state({}))).toBe("not_connected");
    expect(connectionOf(agent, undefined)).toBe("not_connected");
  });
});
