// @vitest-environment jsdom
// What an agent listens to (ui/listener-lines.tsx): a line for each live
// listener, by the project's name and what holds it; everything, or
// everything else beside projects of their own; a webhook; and, asked for,
// a project whose own listener stopped.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import type { ListenerShown, RunnerShown } from "@/types/dashboard";
import { ListenerLines } from "@/ui/listener-lines";

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Samurai vs Aliens", rank: "a" },
      { id: "p2", key: "GS", name: "Getting started", rank: "b" },
    ],
    members: [],
  });
});

function lines(
  listeners: ListenerShown[],
  more: { listening_outside_projects?: boolean; listening_projects?: string[]; idle?: boolean } = {},
) {
  const { container } = render(
    <ListenerLines
      reading={{
        listening: listeners.some((l) => l.live) || !!more.listening_outside_projects,
        listeners,
        listening_outside_projects: more.listening_outside_projects ?? false,
        listening_projects: more.listening_projects ?? [],
      }}
      idle={more.idle}
    />,
  );
  return [...container.querySelectorAll("span")].map((span) => span.textContent);
}

describe("what an agent listens to", () => {
  it("names each live listener's project and what holds it, and everything else beside them", () => {
    expect(
      lines(
        [
          { by: "a companion", live: true },
          { project_id: "p1", project: "SVA", by: "a chat", live: true },
        ],
        { listening_outside_projects: true },
      ),
    ).toEqual(["Listening to everything else, from a companion", "Listening to Samurai vs Aliens, from a chat"]);
  });

  it("says everything when no project listens by itself, and a webhook where nothing listens to everything", () => {
    expect(lines([{ by: "a chat", live: true }], { listening_outside_projects: true })).toEqual([
      "Listening to everything, from a chat",
    ]);
    expect(lines([], { listening_outside_projects: true })).toEqual(["A webhook pushes to it"]);
  });

  it("says, when asked, that a project's items wait while its own listener is gone", () => {
    const stopped: ListenerShown = { project_id: "p2", project: "GS", by: "a chat", live: false };
    expect(lines([stopped])).toEqual([]);
    expect(lines([stopped], { idle: true })).toEqual([
      "GS: nothing listens now; its items wait. Say “listen to Quadit for GS” to it in a chat.",
    ]);
    expect(screen.queryByText(/Listening to/)).toBeNull();
  });

  it("says nothing of a project's items waiting while a webhook hears them", () => {
    const stopped: ListenerShown = { project_id: "p2", project: "GS", by: "a chat", live: false };
    expect(
      lines([stopped], { idle: true, listening_outside_projects: true, listening_projects: ["p1", "p2"] }),
    ).toEqual(["A webhook pushes to it"]);
  });
});

describe("a listener Quadit's runner marked", () => {
  const runner = (over: Partial<RunnerShown> = {}, live = true): ListenerShown => ({
    project_id: "p1",
    project: "SVA",
    by: "Quadit's runner",
    live,
    runner: {
      machine: "Aram's MacBook Pro",
      folder: "~/devel/game",
      program: "claude",
      program_version: "2.1.331",
      holding: live,
      since: "2026-11-24 14:02",
      ...over,
    },
  });
  const runs = "Runs Samurai vs Aliens on Aram's MacBook Pro, in ~/devel/game, with Claude Code";

  it("says what runs the agent, where, and that it is ready or what it works on", () => {
    expect(lines([runner()])).toEqual([`${runs}. Ready`]);
    expect(lines([runner({ task: "SVA-12" })])).toEqual([`${runs}. Working on SVA-12`]);
    expect(lines([runner({ program: "codex" })])).toEqual([
      "Runs Samurai vs Aliens on Aram's MacBook Pro, in ~/devel/game, with Codex. Ready",
    ]);
  });

  it.each([
    ["not_signed_in", "Paused: Claude Code is not signed in"],
    ["program_missing", "Paused: Claude Code is not found"],
    ["folder_missing", "Paused: the folder is gone"],
    ["login_mismatch", "Paused: Claude Code works as another agent"],
    ["server_old", "Paused: this server needs an update"],
    ["usage_limit", "Paused: Claude Code's usage limit"],
    ["something_new", "Paused"],
  ])("says it is paused: %s", (paused, status) => {
    expect(lines([runner({ paused, task: "SVA-12" })])).toEqual([`${runs}. ${status}`]);
  });

  it("says until when it is paused for a usage limit", () => {
    expect(lines([runner({ paused: "usage_limit", paused_until: "2026-11-24 18:00" })])[0]).toMatch(
      new RegExp(`^${runs}\\. Paused until .+: Claude Code's usage limit$`),
    );
  });

  it("says a chat holds it for now, and Quadit runs it again after", () => {
    const chat = runner({ holding: false });
    expect(lines([chat])).toEqual([
      "Listening to Samurai vs Aliens, from a chat; Quadit runs it on Aram's MacBook Pro again when that chat stops.",
    ]);
  });

  it("says, when asked, that the computer is offline and its requests wait, in place of the line for a stopped listener", () => {
    const away = runner({}, false);
    expect(lines([away])).toEqual([]);
    expect(lines([away], { idle: true })).toEqual([
      expect.stringMatching(
        /^Runs Samurai vs Aliens on Aram's MacBook Pro: offline since .+\. Its requests wait for it\.$/,
      ),
    ]);
  });
});
