// @vitest-environment jsdom
// The note above the sample tasks (tasks/samples-note.tsx): what they are
// for and which waits on an agent, while any is out of the trash; and the
// button that removes them, after which the page leaves a project that
// went with them.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap, patchRow } from "@/data/store";
import { SamplesNote } from "@/tasks/samples-note";
import type { FeedEvent, Member, Project, User, Workspace } from "@/types/core";

const owner = { user_id: "u1", role: "owner", name: "Maya", kind: "person", handle: "maya" } as Member;
const agent = { user_id: "cc", role: "member", name: "Claude Code", kind: "agent", handle: "claude-code" } as Member;
const project = { id: "gs", key: "GS", name: "Getting started", rank: "a", samples: ["t1", "t2", "t3"] };
const task = (n: number, assignee?: string) => ({
  id: `t${n}`,
  key: `GS-${n}`,
  project_id: "gs",
  status_id: "s1",
  title: `Sample ${n}`,
  priority: 0,
  assignee_id: assignee,
});

/** What the server answers samples.remove with: each task in the trash, and the project too when `alone`. */
let removal: FeedEvent[] = [];

function load(me: Member, third?: string) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: me.user_id } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [owner, agent],
    projects: [project],
    statuses: [{ id: "s1", project_id: "gs", name: "Todo", category: "unstarted", rank: "a" }],
    tasks: [task(1, "u1"), task(2, "u1"), task(3, third)],
  });
}

function show() {
  render(
    <MemoryRouter initialEntries={["/acme/p/GS/tasks"]}>
      <Routes>
        <Route
          path="/acme/p/GS/tasks"
          element={<SamplesNote project={getState().collections.projects.gs as Project} />}
        />
        <Route path="/acme" element={<p>my work</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const event = (seq: number, over: Partial<FeedEvent>): FeedEvent => ({
  seq,
  at: 1000 + seq,
  actor_id: "u1",
  change_id: `c${seq}`,
  type: "task.updated",
  entity_type: "task",
  entity_id: "",
  scope_type: "",
  scope_id: "",
  data: {},
  ...over,
});
const trashed = (seq: number, id: string) =>
  event(seq, { entity_id: id, data: { id, changes: { deleted_at: { from: 0, to: 9 } } } });

beforeEach(() => {
  removal = [trashed(2, "t1"), trashed(3, "t2"), trashed(4, "t3")];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: { type: string }[] };
    return Promise.resolve({ results: changes.map((c) => ({ type: c.type, events: removal })) });
  });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

describe("the note above the sample tasks", () => {
  it("says which waits on an agent, in the agent's name", () => {
    load(owner, "cc");
    show();
    expect(screen.getByText("Three sample tasks to try Quadit with.")).toBeTruthy();
    expect(
      screen.getByText(/GS-3 is for Claude Code: in Claude Code, ask what is on your Quadit list/, { exact: false }),
    ).toBeTruthy();
  });

  it("names no agent when the third is for nobody", () => {
    load(owner);
    show();
    expect(screen.getByText("Three sample tasks to try Quadit with.")).toBeTruthy();
    expect(screen.queryByText(/is for/)).toBeNull();
  });

  it("stays while the samples are archived, which the trash alone takes away", () => {
    load(owner);
    for (const id of ["t1", "t2", "t3"]) patchRow("tasks", id, { archived_at: 5 });
    show();
    expect(screen.getByRole("button", { name: "Remove sample tasks" })).toBeTruthy();
  });

  it("offers the removal to an owner or admin only", () => {
    load({ ...owner, role: "member" });
    show();
    expect(screen.getByText("Three sample tasks to try Quadit with.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove sample tasks" })).toBeNull();
  });

  it("goes once the samples are in the trash, leaving the person's own project where it is", async () => {
    load(owner);
    show();
    expect(screen.getByRole("region", { name: "Sample tasks" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove sample tasks" }));
    expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({ changes: [{ type: "samples.remove", args: {} }] });
    await vi.waitFor(() => expect(screen.queryByRole("region", { name: "Sample tasks" })).toBeNull());
    expect(screen.queryByText("my work")).toBeNull();
  });

  it("leaves the project's page when the project went with them", async () => {
    load(owner);
    removal.push(
      event(5, {
        type: "project.deleted",
        entity_type: "project",
        entity_id: "gs",
        data: { id: "gs", changes: { deleted_at: { from: null, to: 9 } } },
      }),
    );
    show();
    await userEvent.click(screen.getByRole("button", { name: "Remove sample tasks" }));
    expect(await screen.findByText("my work")).toBeTruthy();
  });
});
