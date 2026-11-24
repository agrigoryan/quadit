// @vitest-environment jsdom
// The line under the comment box (detail/comment-reach.tsx): for each agent
// what is written reaches (the task's when the draft mentions nobody, else
// those it mentions, and whom it hands the task to), what will happen to
// it, in each of the agent's three states, with the way to connect one that
// never has: the app's Connect in the desktop app, its page in Settings in
// a browser.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { EMPTY_DRAFT, editDraft, useDrafts } from "@/detail/comment-actions";
import { CommentReach } from "@/detail/comment-reach";
import { WithQuery } from "@/test/query";
import type { AgentSession, Member, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const ann = { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member;
const codex = { user_id: "a1", handle: "codex", name: "Codex", kind: "agent", role: "member" } as Member;
const helper = {
  user_id: "a2",
  handle: "helper",
  name: "Helper",
  kind: "agent",
  role: "member",
  connected_at: 1,
} as Member;
const gemini = { user_id: "a3", handle: "gemini", name: "Gemini", kind: "agent", role: "member" } as Member;
const bea = { user_id: "u2", handle: "bea", name: "Bea", kind: "person", role: "member" } as Member;
const base = { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Boss" } as Task;

/**
 * The store with `agent` (and @helper, @gemini and @bea), the project SVA
 * (with `project`'s fields) and, with `others`, a second project, GS.
 */
function load(agent: Member, project: Record<string, unknown> = {}, others = false, sessions: AgentSession[] = []) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: ann,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Game", rank: "a", ...project },
      ...(others ? [{ id: "p2", key: "GS", name: "Getting started", rank: "b" }] : []),
    ],
    members: [ann, agent, helper, gemini, bea],
    sessions,
  });
}

/**
 * What GET /agents/connection answers about @codex: whether it listens (to
 * every project, unless `projects` names those it does), and the tool of
 * its last connect code.
 */
function agents(listening: boolean, tool?: string, projects = listening ? ["p1"] : []) {
  vi.spyOn(api, "get").mockResolvedValue({
    agents: [
      {
        user_id: "a1",
        handle: "@codex",
        listening,
        tool,
        listeners: [],
        listening_projects: projects,
        listening_outside_projects: listening,
      },
    ],
  });
}

function show(task: Task) {
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <CommentReach task={task} />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

beforeEach(() => load({ ...codex, connected_at: 1700000000000 }));

afterEach(() => {
  useDrafts.setState({ drafts: {} });
  vi.restoreAllMocks();
  delete window.quaditDesktop;
});

describe("the line under the comment box", () => {
  it("says an agent that is listening will see it", async () => {
    agents(true);
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText("@codex is listening and will see this.")).toBeTruthy();
  });

  it("says when an agent that is not listening will see it, and what to say to it in a chat, naming the project when it has several", async () => {
    load({ ...codex, connected_at: 1700000000000 }, {}, true);
    agents(false, "Codex");
    show({ ...base, assignee_id: "u1", waiting_on_id: "a1" });
    expect(
      await screen.findByText(
        "@codex is not listening. To have it answer here, say “listen to Quadit for SVA” in Codex. Until then it sees this when you next ask it, for example “check Quadit”.",
      ),
    ).toBeTruthy();
  });

  it("says plain “listen to Quadit” to an agent with one project: it then listens to everything, a project added later too", async () => {
    agents(false, "Codex");
    show({ ...base, assignee_id: "a1" });
    expect(
      await screen.findByText(
        "@codex is not listening. To have it answer here, say “listen to Quadit” in Codex. Until then it sees this when you next ask it, for example “check Quadit”.",
      ),
    ).toBeTruthy();
    cleanup();
    // Several projects in the workspace, but the agent may work in one of them only.
    load({ ...codex, connected_at: 1700000000000, scope: { projects: ["p1"] } }, {}, true);
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText(/say “listen to Quadit” in Codex\./)).toBeTruthy();
  });

  it("says when the agent listens only to other projects, and the line that has it listen to this one", async () => {
    agents(true, "Codex", ["p2"]);
    show({ ...base, assignee_id: "a1" });
    expect(
      await screen.findByText(
        "@codex is listening to other projects, not to this one. To have it answer here, say “listen to Quadit for SVA” to it in a chat in this project’s folder. Until then it sees this when you next ask it, for example “check Quadit”.",
      ),
    ).toBeTruthy();
  });

  it("names the project of a task in an archived project, and leaves it out when there is none to name", async () => {
    load({ ...codex, connected_at: 1700000000000 }, { archived_at: 1 }, true);
    agents(false, "Codex");
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText(/say “listen to Quadit for SVA” in Codex\./)).toBeTruthy();
    cleanup();
    show({ ...base, project_id: "gone", assignee_id: "a1" });
    expect(await screen.findByText(/say “listen to Quadit” in Codex\./)).toBeTruthy();
  });

  it("names no tool for an agent whose tool is not known", async () => {
    agents(false);
    show({ ...base, assignee_id: "a1" });
    expect(
      await screen.findByText(
        "@codex is not listening. To have it answer here, say “listen to Quadit” to it in a chat. Until then it sees this when you next ask it to check Quadit.",
      ),
    ).toBeTruthy();
  });

  it("offers a browser the agent's page in Settings for an agent that has not connected", async () => {
    load(codex);
    agents(false);
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText("@codex has not connected yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect it in Settings" }).getAttribute("href")).toBe(
      "/acme/settings/agents/codex",
    );
  });

  it("offers the desktop app's Connect for an agent that has not connected", async () => {
    load(codex);
    agents(false);
    const openConnect = vi.fn();
    window.quaditDesktop = { version: "0.1.0", notify: () => {}, setBadge: () => {}, openConnect };
    show({ ...base, assignee_id: "a1" });
    fireEvent.click(await screen.findByRole("button", { name: "Connect it" }));
    expect(openConnect).toHaveBeenCalledOnce();
  });

  it("says nothing on a task that is a person's", () => {
    const get = vi.spyOn(api, "get");
    show({ ...base, assignee_id: "u1" });
    expect(screen.queryByText(/codex/)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the line under the comment box, as the draft goes", () => {
  /** What GET /agents/connection answers: @codex listening to SVA, @helper connected and not listening, @gemini never connected. */
  function three() {
    vi.spyOn(api, "get").mockResolvedValue({
      agents: [
        { user_id: "a1", handle: "@codex", listening: true, listening_projects: ["p1"], listeners: [] },
        { user_id: "a2", handle: "@helper", listening: false, listening_projects: [], listeners: [] },
        { user_id: "a3", handle: "@gemini", listening: false, listening_projects: [], listeners: [] },
      ],
    });
  }
  const draft = (body: string, handTo: string | null = null) =>
    editDraft("t1", () => ({ ...EMPTY_DRAFT, body, handTo }));

  it("says nothing of the task's agent when the draft mentions only a person", () => {
    const get = vi.spyOn(api, "get");
    draft("@bea can you look?");
    show({ ...base, assignee_id: "a1" });
    expect(screen.queryByText(/codex/)).toBeNull();
    // Nothing reaches an agent, so nothing asks how far one is connected.
    expect(get).not.toHaveBeenCalled();
  });

  it("speaks of the agent the draft mentions, not of the task's agent it leaves out", async () => {
    three();
    draft("@helper and @bea, can you look?");
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText(/^@helper is not listening\./)).toBeTruthy();
    expect(screen.queryByText(/codex/)).toBeNull();
  });

  it("speaks of an agent mentioned on a task that is a person's", async () => {
    three();
    draft("@codex can you look?");
    show({ ...base, assignee_id: "u1" });
    expect(await screen.findByText("@codex is listening and will see this.")).toBeTruthy();
  });

  it("still speaks of the task's agent when the draft mentions only its writer", async () => {
    three();
    draft("Note to @ann: the boss is done.");
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText("@codex is listening and will see this.")).toBeTruthy();
  });

  it("speaks of the agent the task is handed to, beside the task's own, in few words", async () => {
    three();
    draft("Over to you.", "a2");
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText("@codex is listening and will see this.")).toBeTruthy();
    expect(screen.getByText("@helper is not listening here and sees this when next asked.")).toBeTruthy();
  });

  it("puts several agents in each state together, with one way to connect those that have not", async () => {
    three();
    draft("@codex, @helper and @gemini: who has the boss?");
    show({ ...base, assignee_id: "u1" });
    expect(await screen.findByText("@codex is listening and will see this.")).toBeTruthy();
    expect(screen.getByText("@helper is not listening here and sees this when next asked.")).toBeTruthy();
    expect(screen.getByText("@gemini has not connected yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect it in Settings" }).getAttribute("href")).toBe(
      "/acme/settings/agents/gemini",
    );
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, "get").mockResolvedValue({
      agents: [
        { user_id: "a1", handle: "@codex", listening: true, listening_projects: ["p1"], listeners: [] },
        { user_id: "a2", handle: "@helper", listening: true, listening_projects: ["p1"], listeners: [] },
      ],
    });
    draft("@codex and @helper: who has the boss?");
    show({ ...base, assignee_id: "u1" });
    expect(await screen.findByText("@codex and @helper are listening and will see this.")).toBeTruthy();
  });

  it("leaves out an agent that may not read the task's project, which the server does not tell", async () => {
    three();
    load({ ...codex, connected_at: 1, scope: { projects: ["p2"] } });
    draft("@codex and @helper, can you look?");
    show({ ...base, assignee_id: "u1" });
    expect(await screen.findByText(/^@helper is not listening\./)).toBeTruthy();
    expect(screen.queryByText(/codex/)).toBeNull();
  });
});

describe("the line under the comment box, for an agent a computer runs", () => {
  /** A runner listener of SVA on Aram's MacBook Pro. */
  const runner = {
    project_id: "p1",
    project: "SVA",
    by: "Quadit's runner",
    live: true,
    runner: {
      machine: "Aram's MacBook Pro",
      folder: "~/devel/game",
      program: "claude",
      program_version: "2",
      holding: true,
      since: "2026-11-24 14:02",
    },
  };

  /**
   * GET /agents/connection says Quadit runs @codex (and, with `helperToo`,
   * @helper); the run outlook answers `outlooks`, each with the fields it
   * leaves out empty, as the server sends them all. Gives the paths asked.
   */
  function serve(outlooks: Record<string, string>[], helperToo = false) {
    const asked: string[] = [];
    vi.spyOn(api, "get").mockImplementation((path: string) => {
      asked.push(path);
      if (path.includes("/run-outlook"))
        return Promise.resolve({
          outlooks: outlooks.map((o) => ({
            agent: "@codex",
            machine: "Aram's MacBook Pro",
            folder: "~/devel/game",
            program: "claude",
            project: "SVA",
            owner: "@ann",
            since: "",
            until: "",
            running: "",
            reason: "",
            ...o,
          })),
        });
      return Promise.resolve({
        agents: [
          { user_id: "a1", handle: "@codex", listening: true, listening_projects: ["p1"], listeners: [runner] },
          {
            user_id: "a2",
            handle: "@helper",
            listening: helperToo,
            listening_projects: helperToo ? ["p1"] : [],
            listeners: helperToo ? [runner] : [],
          },
        ],
      });
    });
    return asked;
  }

  it.each([
    [{ outcome: "starts_now" }, "Starts @codex now on Aram's MacBook Pro."],
    // The run the computer works on may be another agent's, even on this task: only a run of its own is promised.
    [{ outcome: "queued", running: "SVA-1" }, "Queued for @codex on Aram's MacBook Pro."],
    [{ outcome: "queued", running: "SVA-9" }, "Queued for @codex on Aram's MacBook Pro."],
    [{ outcome: "queued" }, "Queued for @codex on Aram's MacBook Pro."],
    [
      { outcome: "paused", reason: "usage_limit" },
      "Starts @codex when Claude Code's usage limit resets on Aram's MacBook Pro.",
    ],
    [
      { outcome: "paused", reason: "not_signed_in" },
      "Will not start yet: Claude Code is not signed in on Aram's MacBook Pro. Sign in there, and it starts.",
    ],
    [
      { outcome: "paused", reason: "program_missing", program: "codex" },
      "Will not start yet: Codex is not found on Aram's MacBook Pro. Install it there, and it starts.",
    ],
    [
      { outcome: "paused", reason: "folder_missing" },
      "Will not start yet: the folder ~/devel/game is gone on Aram's MacBook Pro. Pick the folder again in the Quadit app.",
    ],
    [
      { outcome: "paused", reason: "login_mismatch" },
      "Will not start yet: Claude Code on Aram's MacBook Pro is set to work as another agent. Connect @codex again in the Quadit app.",
    ],
    [
      { outcome: "paused", reason: "server_old" },
      "Will not start yet: Quadit on Aram's MacBook Pro needs this server updated.",
    ],
    [
      { outcome: "will_not_start", reason: "not_responsible" },
      "Will not start: only Ann's words, or their agents', start @codex. Ask Ann, or assign the task to an agent of your own.",
    ],
    [
      { outcome: "will_not_start", reason: "no_responsible", owner: "" },
      "Will not start: @codex has no person responsible for it. An admin can set one in Settings.",
    ],
  ])("%o: says what will happen", async (outlook, line) => {
    serve([outlook]);
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText(line)).toBeTruthy();
    expect(screen.queryByText(/is listening/)).toBeNull();
  });

  it("names the time a usage limit resets, and since when a computer is offline", async () => {
    serve([{ outcome: "paused", reason: "usage_limit", until: "2026-11-24 18:00" }]);
    show({ ...base, assignee_id: "a1" });
    expect(
      await screen.findByText(/^Starts @codex at .+, when Claude Code's usage limit resets on Aram's MacBook Pro\.$/),
    ).toBeTruthy();
    cleanup();
    vi.restoreAllMocks();
    serve([{ outcome: "when_back", since: "2026-11-24 14:02" }]);
    show({ ...base, assignee_id: "a1" });
    expect(
      await screen.findByText(/^Starts @codex when Aram's MacBook Pro is back\. It has been offline since .+\.$/),
    ).toBeTruthy();
  });

  it("asks about the agents the draft reaches, for a comment on this task", async () => {
    const asked = serve([{ outcome: "starts_now" }]);
    show({ ...base, assignee_id: "a1" });
    await screen.findByText("Starts @codex now on Aram's MacBook Pro.");
    expect(asked).toContain(
      `/api/v1/w/acme/tasks/SVA-1/run-outlook?agents=${encodeURIComponent("@codex")}&cause=comment`,
    );
  });

  it("keeps today's line when Quadit would not start it for this, or a chat holds it", async () => {
    serve([{ outcome: "none" }]);
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText("@codex is listening and will see this.")).toBeTruthy();
    cleanup();
    vi.restoreAllMocks();
    serve([{ outcome: "in_chat" }]);
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText("@codex is listening and will see this.")).toBeTruthy();
  });

  it("says no computer runs it for the project, with the way to set it up: the app's Connect, else words", async () => {
    serve([{ outcome: "will_not_start", reason: "no_runner_here" }]);
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText("Will not start: no computer runs @codex for SVA.")).toBeTruthy();
    expect(screen.getByText("Set it up in the Quadit app, on @codex's card.")).toBeTruthy();
    cleanup();
    const openConnect = vi.fn();
    window.quaditDesktop = { version: "0.1.0", notify: () => {}, setBadge: () => {}, openConnect };
    show({ ...base, assignee_id: "a1" });
    fireEvent.click(await screen.findByRole("button", { name: "Set it up" }));
    expect(openConnect).toHaveBeenCalledOnce();
  });

  it("says a comment comes next in the same session only when the page holds an open run of this agent on this task", async () => {
    const run = (over: Partial<AgentSession>): AgentSession => ({
      id: "s1",
      agent_id: "a1",
      task_id: "t1",
      state: "running",
      machine_id: "0123456789abcdef",
      started_at: 1,
      updated_seq: 1,
      ...over,
    });
    load({ ...codex, connected_at: 1 }, {}, false, [run({})]);
    serve([{ outcome: "queued", running: "SVA-1" }]);
    show({ ...base, assignee_id: "a1" });
    expect(
      await screen.findByText(
        "@codex is working on this task on Aram's MacBook Pro. This comes next, in the same session.",
      ),
    ).toBeTruthy();
    cleanup();
    for (const other of [run({ agent_id: "a2" }), run({ task_id: "t9" }), run({ state: "done" })]) {
      load({ ...codex, connected_at: 1 }, {}, false, [other]);
      show({ ...base, assignee_id: "a1" });
      expect(await screen.findByText("Queued for @codex on Aram's MacBook Pro.")).toBeTruthy();
      cleanup();
    }
  });

  it("says nothing of an agent a computer runs while the outlook cannot be read, and goes on about the others", async () => {
    vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path.includes("/run-outlook")) return Promise.reject(new Error("the server is away"));
      return Promise.resolve({
        agents: [
          { user_id: "a1", handle: "@codex", listening: true, listening_projects: ["p1"], listeners: [runner] },
          { user_id: "a3", handle: "@gemini", listening: false, listening_projects: [], listeners: [] },
        ],
      });
    });
    show({ ...base, assignee_id: "a1" });
    await waitFor(() =>
      expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes("/run-outlook"))).toBe(true),
    );
    await act(() => new Promise((done) => setTimeout(done, 0)));
    expect(screen.queryByText(/codex/)).toBeNull();
    cleanup();
    editDraft("t1", () => ({ ...EMPTY_DRAFT, body: "@codex and @gemini: who has the boss?" }));
    show({ ...base, assignee_id: "u1" });
    expect(await screen.findByText("@gemini has not connected yet.")).toBeTruthy();
    expect(screen.queryByText(/codex/)).toBeNull();
  });

  it("says a comment is queued in a few words among several agents", async () => {
    serve([{ outcome: "queued", running: "SVA-1" }]);
    editDraft("t1", () => ({ ...EMPTY_DRAFT, body: "@codex and @gemini: who has the boss?" }));
    show({ ...base, assignee_id: "u1" });
    expect(await screen.findByText("Queued for @codex on Aram's MacBook Pro.")).toBeTruthy();
  });

  it("says it in a few words for each of several agents, beside today's words for the others", async () => {
    serve(
      [{ outcome: "starts_now" }, { agent: "@helper", outcome: "will_not_start", reason: "not_responsible" }],
      true,
    );
    editDraft("t1", () => ({ ...EMPTY_DRAFT, body: "@codex, @helper and @gemini: who has the boss?" }));
    show({ ...base, assignee_id: "u1" });
    expect(await screen.findByText("@codex starts now on Aram's MacBook Pro.")).toBeTruthy();
    expect(screen.getByText("@helper will not start: only Ann's words start it.")).toBeTruthy();
    expect(screen.getByText("@gemini has not connected yet.")).toBeTruthy();
  });
});
