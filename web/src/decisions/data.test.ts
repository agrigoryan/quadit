// @vitest-environment jsdom
// What the signed-in person may do with a decision (decisions/data.ts,
// useViewer): the server refuses every change from a read-only member and
// every change on a task in the trash, so neither is offered.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useViewer } from "@/decisions/data";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Decision, Member, Task, User, Workspace } from "@/lib/types";

const decision = {
  id: "d1",
  task_id: "t1",
  kind: "choice",
  question: "Which?",
  state: "open",
  asked_id: "u1",
  created_by: "u2",
  created_at: 1,
  rank: "a",
} as Decision;

function seed(me: Partial<Member>, task: Partial<Task> = {}) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Ann", kind: "person", handle: "ann", ...me } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    tasks: [{ id: "t1", key: "SVA-1", project_id: "p1", title: "task", ...task }],
    decisions: [decision],
  });
}

const viewer = () => renderHook(() => useViewer(decision)).result.current;

beforeEach(() => seed({}));

describe("useViewer", () => {
  it("lets the one asked answer and comment", () => {
    expect(viewer()).toMatchObject({ mine: true, canAnswer: true, canComment: true });
  });

  it("offers a read-only member no answer, comment or delete", () => {
    seed({ role: "admin", scope: { read_only: true } });
    expect(viewer()).toMatchObject({ canAnswer: false, canComment: false, canDelete: false });
  });

  it("offers nothing on a task in the trash", () => {
    seed({}, { deleted_at: 5 });
    expect(viewer()).toMatchObject({ canAnswer: false, canComment: false });
  });

  it("lets an admin delete someone else's question, and a member only their own", () => {
    expect(viewer().canDelete).toBe(false);
    seed({ role: "admin" });
    expect(viewer().canDelete).toBe(true);
  });
});
