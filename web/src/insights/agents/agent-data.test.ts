// @vitest-environment jsdom
// What waits on each agent (agents/agent-data.ts): a question asked of it
// counts only while its task is live; one on a task in the trash or the
// archive waits on no one.

import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/types/core";
import { useAgentWork } from "@/insights/agents/agent-data";

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
const agent = { user_id: "a1", role: "member", name: "Coder", kind: "agent", handle: "coder" } as Member;

const task = (id: string, extra: object = {}) => ({
  id,
  key: `SVA-${id}`,
  project_id: "p1",
  status_id: "s1",
  title: `Task ${id}`,
  rank: id,
  created_at: 0,
  updated_at: 0,
  ...extra,
});
const asked = (id: string, taskId: string) => ({
  id,
  task_id: taskId,
  kind: "choice",
  question: `Question on ${taskId}`,
  state: "open",
  asked_id: "a1",
  created_by: "u1",
  created_at: 1,
});

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me, agent],
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a" }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    tasks: [task("1"), task("2", { archived_at: 5 }), task("3", { deleted_at: 6 })],
    decisions: [asked("d1", "1"), asked("d2", "2"), asked("d3", "3")],
  });
});

it("counts only the questions asked of an agent on live tasks", () => {
  const { result } = renderHook(() => useAgentWork([]));
  expect(result.current.a1?.asked.map((a) => a.decision.id)).toEqual(["d1"]);
});
