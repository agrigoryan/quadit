import { describe, expect, it } from "vitest";
import { defaultChoice, handleOf } from "@/shared/default-choice";

const workspace = { id: "w1", slug: "personal", name: "Personal" };
const agent = { handle: "claude-code", name: "Claude Code", state: "idle" as const, detail: "", path: "/" };

describe("defaultChoice", () => {
  it("connects the command and its skill, as a new agent named after the tool, asking nothing", () => {
    expect(defaultChoice({ id: "claude", name: "Claude Code" }, "s1", { workspace, agents: [] })).toEqual({
      harness: "claude",
      serverId: "s1",
      workspaceId: "w1",
      methods: ["cli"],
      agent: { create: { name: "Claude Code", handle: "claude-code" } },
      allowUnattended: false,
    });
  });

  it("works as the tool's agent when the workspace has one the person may work as", () => {
    const usable = { ...agent, id: "u7", usable: true };
    expect(defaultChoice({ id: "claude", name: "Claude Code" }, "s1", { workspace, agents: [usable] }).agent).toEqual({
      id: "u7",
    });
    const notMine = { ...agent, id: "u8", usable: false };
    expect(defaultChoice({ id: "claude", name: "Claude Code" }, "s1", { workspace, agents: [notMine] }).agent).toEqual({
      create: { name: "Claude Code", handle: "claude-code" },
    });
  });
});

describe("handleOf", () => {
  it("makes a handle of a tool's name", () => {
    expect(handleOf("GitHub Copilot CLI")).toBe("github-copilot-cli");
    expect(handleOf("pi")).toBe("pi");
  });
});
