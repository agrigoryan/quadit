// What the page does when the desktop app asks (shell/desktop-requests.ts):
// each request is carried out through the page's own write paths, and a
// refusal comes back to the app in the server's words.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { queryClient } from "@/data/query";
import { clearStore, getState, loadBootstrap, patchRow } from "@/data/store";
import { clearUndo } from "@/data/undo";
import { answer } from "@/shell/desktop-requests";
import type { Member, User, Workspace } from "@/types/core";

type Sent = { type: string; args: Record<string, unknown> };
let changes: Sent[] = [];
let posts: { path: string; body: unknown }[] = [];
let refuse: string | undefined;

const sent = () => changes.map(({ type, args }) => ({ type, args }));

beforeEach(() => {
  changes = [];
  posts = [];
  refuse = undefined;
  vi.spyOn(api, "post").mockImplementation((path: string, body?: unknown) => {
    if (refuse) return Promise.reject(new ApiError(403, { code: "forbidden", message: refuse }));
    if (path.includes("/changes?")) {
      const batch = (body as { changes: Sent[] }).changes;
      changes.push(...batch);
      return Promise.resolve({ results: batch.map((c) => ({ key: c.type === "task.create" ? "SVA-9" : undefined })) });
    }
    posts.push({ path, body });
    if (path.endsWith("/connect-codes"))
      return Promise.resolve({ id: "cc1", code: "K7PQ2M", agent: "a1", tool: "Codex" });
    return Promise.resolve({ token: "qd_secret", info: { id: "tok1", name: "Claude Code on mac" } });
  });
  vi.spyOn(api, "del").mockResolvedValue({ ok: true });
  clearStore();
  clearUndo();
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1", role: "member" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    members: [
      { user_id: "u1", name: "Ann", handle: "ann", kind: "person" },
      { user_id: "a1", name: "Claude", handle: "claude", kind: "agent", responsible_id: "u1" },
    ] as Member[],
    projects: [
      { id: "p1", key: "SVA", name: "Samurai", rank: "a" },
      { id: "gs", key: "GS", name: "Getting started", rank: "b", samples: ["g1", "g2", "g3"] },
    ],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", is_default: true, rank: "a" }],
    tasks: [
      { id: "t1", key: "SVA-5", title: "Jump feels floaty", project_id: "p1" },
      { id: "g1", key: "GS-1", title: "Open this task", project_id: "gs", assignee_id: "u1" },
      { id: "g2", key: "GS-2", title: "Write a page", project_id: "gs", assignee_id: "u1" },
      { id: "g3", key: "GS-3", title: "Say hello", project_id: "gs" },
    ],
    decisions: [
      {
        id: "d1",
        task_id: "t1",
        kind: "choice",
        question: "Which jump?",
        state: "open",
        asked_id: "u1",
        options: [{ id: "o1", decision_id: "d1", label: "Higher", rank: "a" }],
      },
    ],
    notifications: [
      { id: "n1", user_id: "u1", seq: 5, type: "replied", task_id: "t1", entity_type: "comment", entity_id: "c1" },
      { id: "n2", user_id: "u1", seq: 6, type: "mentioned", doc_id: "doc1", entity_type: "doc", entity_id: "doc1" },
    ],
  });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

describe("a button pressed in the app", () => {
  it("answers the question with the option, and shows it answered", async () => {
    expect(await answer({ kind: "action", request: "pick:d1:o1" })).toEqual({ ok: true });
    expect(sent()).toEqual([{ type: "decision.pick", args: { id: "d1", option: "o1" } }]);
    expect(getState().collections.decisions.d1?.state).toBe("picked");
  });

  it("replies in the thread the item was said in, or on its page", async () => {
    expect(await answer({ kind: "action", request: "reply:n1", text: "On it" })).toEqual({ ok: true });
    expect(await answer({ kind: "action", request: "reply:n2", text: "Agreed" })).toEqual({ ok: true });
    expect(sent()).toEqual([
      { type: "comment.create", args: { parent: "c1", body: "On it" } },
      { type: "comment.create", args: { doc: "doc1", body: "Agreed" } },
    ]);
  });

  it("marks the item read", async () => {
    expect(await answer({ kind: "action", request: "read:n1" })).toEqual({ ok: true });
    expect(sent()).toEqual([{ type: "notification.read", args: { ids: ["n1"] } }]);
    expect(getState().collections.notifications.n1?.read_at).toBeTruthy();
  });

  it("is refused for what is not here, and for an empty reply", async () => {
    expect(await answer({ kind: "action", request: "pick:gone:o1" })).toMatchObject({ ok: false });
    expect(await answer({ kind: "action", request: "reply:n1", text: " " })).toMatchObject({ ok: false });
    expect(await answer({ kind: "action", request: "rename:n1" })).toMatchObject({ ok: false });
    expect(sent()).toEqual([]);
  });
});

describe("quick capture", () => {
  it("creates a task in the project, and says where it is", async () => {
    const outcome = await answer({
      kind: "capture",
      project: "SVA",
      what: "task",
      title: "Fix the jump",
      body: "Too floaty",
    });
    expect(outcome).toEqual({ ok: true, path: "/acme/task/SVA-9" });
    expect(sent()).toEqual([
      {
        type: "task.create",
        args: expect.objectContaining({ project: "p1", title: "Fix the jump", description: "Too floaty" }),
      },
    ]);
  });

  it("creates a page, in a project or in the workspace", async () => {
    const outcome = await answer({ kind: "capture", project: null, what: "page", title: "Notes", body: "# Hi" });
    const id = sent()[0]?.args.id;
    expect(outcome).toEqual({ ok: true, path: `/acme/docs/${String(id)}` });
    expect(sent()).toEqual([{ type: "doc.create", args: { id, title: "Notes", markdown: "# Hi" } }]);
  });

  it("refuses a task without a project", async () => {
    expect(await answer({ kind: "capture", project: null, what: "task", title: "Fix", body: "" })).toMatchObject({
      ok: false,
    });
  });
});

describe("Connect", () => {
  it("creates a standing agent and names it", async () => {
    const outcome = await answer({ kind: "agent", create: { name: "Codex", handle: "codex" } });
    const id = sent()[0]?.args.id;
    expect(sent()).toEqual([{ type: "agent.create", args: { id, name: "Codex", handle: "codex" } }]);
    expect(outcome).toEqual({ ok: true, agent: { id, handle: "codex", name: "Codex" } });
  });

  it("makes a token for an agent under the label given, that does not expire", async () => {
    const outcome = await answer({ kind: "agent-token", agent: "a1", label: "Claude Code on mac" });
    expect(posts).toEqual([{ path: "/api/v1/w/acme/tokens", body: { user: "@claude", name: "Claude Code on mac" } }]);
    expect(outcome).toEqual({
      ok: true,
      token: { id: "tok1", secret: "qd_secret" },
      agent: { id: "a1", handle: "claude", name: "Claude" },
    });
  });

  it("revokes a token", async () => {
    expect(await answer({ kind: "revoke-token", token: "tok1" })).toEqual({ ok: true });
    expect(api.del).toHaveBeenCalledWith("/api/v1/w/acme/tokens/tok1");
  });

  it("says the server's refusal in its words", async () => {
    refuse = "only an admin or the person responsible for @claude may make it a token";
    expect(await answer({ kind: "agent-token", agent: "a1", label: "x" })).toEqual({ ok: false, message: refuse });
    refuse = "agent.create needs the admin role; you are a member";
    expect(await answer({ kind: "agent", create: { name: "Codex", handle: "codex" } })).toEqual({
      ok: false,
      message: refuse,
    });
  });
});

describe("the end of the app's first run", () => {
  it("gives the third sample to the agent connected, and says where the samples are", async () => {
    expect(await answer({ kind: "samples", agent: "a1" })).toEqual({ ok: true, path: "/acme/p/GS/tasks" });
    expect(sent()).toEqual([{ type: "task.update", args: { id: "g3", assignee: "a1" } }]);
    expect(posts).toEqual([]);
  });

  it("only says where they are when no agent was connected, or the third has someone", async () => {
    expect(await answer({ kind: "samples" })).toEqual({ ok: true, path: "/acme/p/GS/tasks" });
    patchRow("tasks", "g3", { assignee_id: "u1" });
    expect(await answer({ kind: "samples", agent: "a1" })).toEqual({ ok: true, path: "/acme/p/GS/tasks" });
    expect(sent()).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("makes no samples where there are none, and opens the workspace", async () => {
    for (const id of ["g1", "g2", "g3"]) patchRow("tasks", id, { deleted_at: 9 });
    expect(await answer({ kind: "samples", agent: "a1" })).toEqual({ ok: true, path: "/acme" });
    expect(sent()).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("gives the third sample to an agent only", async () => {
    expect(await answer({ kind: "samples", agent: "u1" })).toMatchObject({ ok: false });
    expect(sent()).toEqual([]);
  });
});

/** An agent's reading as GET /agents/connection gives it: listening to nothing unless `more` says. */
const reading = (more: Record<string, unknown>) => ({
  listeners: [],
  listening_projects: [],
  listening_outside_projects: false,
  ...more,
});

/** What the card is told of listeners when nothing listens: none, and every project unheard. */
const NOTHING_HEARD = { listeners: [], pushed: false, unheard: ["SVA", "GS"] };

describe("a tool's card in the app's Connect", () => {
  let reads: string[] = [];
  const serve = (agents: Record<string, unknown>[], used: boolean) =>
    vi.spyOn(api, "get").mockImplementation((path: string) => {
      reads.push(path);
      if (path.endsWith("/agents/connection")) return Promise.resolve({ agents: agents.map(reading) });
      return Promise.resolve({ id: "cc1", used, expired: false });
    });
  beforeEach(() => {
    reads = [];
    queryClient.clear();
  });

  it("makes a connect code for the agent and the tool, and hands back its id and its characters", async () => {
    expect(await answer({ kind: "connect-code", agent: "a1", tool: "Codex" })).toEqual({
      ok: true,
      id: "cc1",
      code: "K7PQ2M",
    });
    expect(posts).toEqual([{ path: "/api/v1/w/acme/connect-codes", body: { agent: "a1", tool: "Codex" } }]);
    expect(await answer({ kind: "connect-code", agent: "u1", tool: "Codex" })).toMatchObject({ ok: false });
  });

  it("says an agent is not connected yet, then that its code was used and it is connected", async () => {
    serve([{ user_id: "a1", listening: false }], false);
    expect(await answer({ kind: "agent-state", agent: "a1", code: "cc1" })).toEqual({
      ok: true,
      connected: false,
      listening: false,
      codeUsed: false,
      codeGone: false,
      ...NOTHING_HEARD,
    });
    serve([{ user_id: "a1", listening: false }], true);
    patchRow("members", "a1", { connected_at: 1700000000000 });
    expect(await answer({ kind: "agent-state", agent: "a1", code: "cc1" })).toEqual({
      ok: true,
      connected: true,
      listening: false,
      codeUsed: true,
      codeGone: false,
      ...NOTHING_HEARD,
    });
  });

  it("says it is listening, from a reading of the agents shared for a few seconds, and asks about no code unless given one", async () => {
    serve(
      [
        {
          user_id: "a1",
          listening: true,
          connected_at: "2026-11-21 14:02",
          listeners: [{ project_id: "p1", project: "SVA", by: "a chat", live: true }],
          listening_projects: ["p1"],
        },
      ],
      false,
    );
    for (let i = 0; i < 3; i++) {
      expect(await answer({ kind: "agent-state", agent: "a1" })).toEqual({
        ok: true,
        connected: true,
        listening: true,
        codeUsed: false,
        codeGone: false,
        // What listens, by project name, for the card; and what nothing hears, for "listen to another".
        listeners: [{ project: { key: "SVA", name: "Samurai" }, by: "a chat" }],
        pushed: false,
        unheard: ["GS"],
      });
    }
    expect(reads).toEqual(["/api/v1/w/acme/agents/connection"]);
  });

  it("says which listener Quadit's runner holds now, and not one a chat took from it", async () => {
    const runner = { machine: "Lou's Mac", folder: "~/game", program: "claude", program_version: "2.1.331", since: "" };
    serve(
      [
        {
          user_id: "a1",
          listening: true,
          connected_at: "2026-11-21 14:02",
          listeners: [
            {
              project_id: "p1",
              project: "SVA",
              by: "Quadit's runner",
              live: true,
              runner: { ...runner, holding: true },
            },
            { project_id: "gs", project: "GS", by: "a chat", live: true, runner: { ...runner, holding: false } },
          ],
          listening_projects: ["p1", "gs"],
        },
      ],
      false,
    );
    expect(await answer({ kind: "agent-state", agent: "a1" })).toMatchObject({
      listeners: [
        { project: { key: "SVA", name: "Samurai" }, by: "Quadit's runner", runner: true },
        { project: { key: "GS", name: "Getting started" }, by: "a chat" },
      ],
    });
  });

  it("names as unheard only the projects the agent itself may work in", async () => {
    patchRow("members", "a1", { scope: { projects: ["p1"] } });
    serve([{ user_id: "a1", listening: false, connected_at: "2026-11-21 14:02" }], false);
    expect(await answer({ kind: "agent-state", agent: "a1" })).toMatchObject({ unheard: ["SVA"] });
  });

  it("says a code replaced or cleared away since is gone, unused", async () => {
    vi.spyOn(api, "get").mockImplementation((path: string) =>
      path.endsWith("/agents/connection")
        ? Promise.resolve({ agents: [reading({ user_id: "a1", listening: false })] })
        : Promise.reject(new ApiError(404, { code: "not_found", message: "connect code not found" })),
    );
    expect(await answer({ kind: "agent-state", agent: "a1", code: "gone" })).toEqual({
      ok: true,
      connected: false,
      listening: false,
      codeUsed: false,
      codeGone: true,
      ...NOTHING_HEARD,
    });
  });

  it("refuses a member that is not an agent", async () => {
    serve([], false);
    expect(await answer({ kind: "agent-state", agent: "u1" })).toMatchObject({ ok: false });
  });
});
