// @vitest-environment jsdom
// The line under the comment box (detail/comment-reach.tsx): for each agent
// what is written reaches (the task's when the draft mentions nobody, else
// those it mentions, and whom it hands the task to), what will happen to
// it, in each of the agent's three states, with the way to connect one that
// never has: the app's Connect in the desktop app, its page in Settings in
// a browser.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { EMPTY_DRAFT, editDraft, useDrafts } from "@/detail/comment-actions";
import { CommentReach } from "@/detail/comment-reach";
import { WithQuery } from "@/test/query";
import type { Member, Task, User, Workspace } from "@/types/core";
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
function load(agent: Member, project: Record<string, unknown> = {}, others = false) {
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
