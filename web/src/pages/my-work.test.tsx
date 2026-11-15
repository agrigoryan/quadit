// @vitest-environment jsdom
// My work (pages/my-work.tsx): the questions asked of me are those on tasks
// still in use; one on a task in the trash or the archive waits on no one.

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/types/core";
import { MyWorkPage } from "@/pages/my-work";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;

const task = (id: string, extra: object = {}) => ({
  id,
  key: `SVA-${id}`,
  project_id: "p1",
  status_id: "s1",
  title: `Task ${id}`,
  priority: 0,
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
  asked_id: "u1",
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
    members: [me],
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a" }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    tasks: [task("1"), task("2", { archived_at: 5 }), task("3", { deleted_at: 6 })],
    decisions: [asked("d1", "1"), asked("d2", "2"), asked("d3", "3")],
  });
});

it("lists only the questions asked of me on live tasks", () => {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <MyWorkPage />
      </TooltipProvider>
    </MemoryRouter>,
  );
  expect(screen.getByRole("link", { name: "Question on 1" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Question on 2" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Question on 3" })).toBeNull();
});
