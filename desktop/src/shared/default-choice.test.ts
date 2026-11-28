import { describe, expect, it } from "vitest";
import { defaultChoice } from "@/shared/default-choice";

const agent = (id: string, handle: string, usable = true) => ({
  id,
  handle,
  name: handle,
  state: "idle" as const,
  detail: "",
  path: "/x",
  usable,
});
const workspace = { id: "w2", slug: "personal", name: "Personal" };
const CLAUDE = { id: "claude", name: "Claude Code" };

describe("defaultChoice", () => {
  it("connects here as well as the agent with the handle the tool has elsewhere: the one there, or one made", () => {
    expect(
      defaultChoice(CLAUDE, "s1", { workspace, agents: [agent("p2", "coder")] }, undefined, "coder").agent,
    ).toEqual({
      id: "p2",
    });
    expect(
      defaultChoice(CLAUDE, "s1", { workspace, agents: [agent("p2", "coder", false)] }, undefined, "coder").agent,
    ).toEqual({ create: { name: "Claude Code", handle: "coder" } });
  });

  it("names a first connection's agent after the tool, and works as the agent a page chose", () => {
    expect(defaultChoice(CLAUDE, "s1", { workspace, agents: [] }).agent).toEqual({
      create: { name: "Claude Code", handle: "claude-code" },
    });
    expect(defaultChoice(CLAUDE, "s1", { workspace, agents: [] }, "u9").agent).toEqual({ id: "u9" });
  });
});
