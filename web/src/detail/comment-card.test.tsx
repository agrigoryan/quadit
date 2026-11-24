// @vitest-environment jsdom
// A comment in the timeline (detail/comment-card.tsx): one Quadit posted for
// a run, from what its program said last, says so beside its author, and
// why when asked.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import { CommentCard } from "@/detail/comment-card";
import { WithQuery } from "@/test/query";
import type { AgentSession, Comment, Member, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const ann = { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member;
const claude = { user_id: "a1", handle: "claude", name: "Claude", kind: "agent", role: "member" } as Member;
const task = { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Boss" } as Task;
const run: AgentSession = {
  id: "s1",
  agent_id: "a1",
  task_id: "t1",
  state: "done",
  program: "codex",
  started_at: 1,
  updated_seq: 1,
};

function load(sessions: AgentSession[] = []) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: ann,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", rank: "a" }],
    members: [ann, claude],
    tasks: [task],
    sessions,
  });
}

function show(over: Partial<Comment>) {
  const comment: Comment = {
    id: "c1",
    task_id: "t1",
    subject_type: "task",
    subject_id: "t1",
    kind: "comment",
    author_id: "a1",
    body: "I changed the boss's health.",
    created_at: 1,
    ...over,
  } as Comment;
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <CommentCard task={task} comment={comment} replies={[]} files={{}} />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

beforeEach(() => load([run]));

describe("a comment a run posted", () => {
  it("says it is the run's last message, and why Quadit posted it, naming the program", async () => {
    show({ session_id: "s1" });
    const label = screen.getByText("From the run's last message");
    fireEvent.focus(label);
    expect(
      (
        await screen.findAllByText(
          "@claude wrote nothing on the task during this run, so Quadit posted what Codex said last.",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("says why without the program once the run is no longer in the copy", async () => {
    load();
    show({ session_id: "s1" });
    fireEvent.focus(screen.getByText("From the run's last message"));
    expect(
      (
        await screen.findAllByText(
          "@claude wrote nothing on the task during this run, so Quadit posted what its program said last.",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("is not said of any other comment", () => {
    show({});
    expect(screen.queryByText("From the run's last message")).toBeNull();
  });
});
