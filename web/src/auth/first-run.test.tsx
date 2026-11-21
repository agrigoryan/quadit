// @vitest-environment jsdom
// The empty workspace's banner (auth/first-run.tsx): beside making the
// first project, an owner or admin can try Quadit with the sample tasks,
// which opens them.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstProjectNudge } from "@/auth/first-run";
import { api } from "@/data/api";
import { applyEvents, clearStore, loadBootstrap } from "@/data/store";
import type { FeedEvent, Member, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const project = { id: "gs", key: "GS", name: "Getting started", rank: "a", samples: ["t1", "t2", "t3"] };

function show(role: string) {
  clearStore();
  const me = { user_id: "u1", role, name: "Maya", kind: "person", handle: "maya" } as Member;
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
  });
  render(
    <MemoryRouter initialEntries={["/acme"]}>
      <TooltipProvider>
        <Routes>
          <Route path="/acme" element={<FirstProjectNudge />} />
          <Route path="/acme/p/GS/tasks" element={<p>the sample tasks</p>} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("the first project banner", () => {
  it("tries it with the sample tasks, and opens them once they are here", async () => {
    const post = vi.spyOn(api, "post").mockImplementation(() => {
      // The feed brings the project, naming its samples, as the answer comes.
      const created: FeedEvent = {
        seq: 2,
        at: 1002,
        actor_id: "u1",
        change_id: "c2",
        type: "project.created",
        entity_type: "project",
        entity_id: "gs",
        scope_type: "project",
        scope_id: "gs",
        data: { row: project },
      };
      applyEvents([created], true);
      return Promise.resolve({ project });
    });
    show("owner");
    await userEvent.click(screen.getByRole("button", { name: "Try it with sample tasks" }));
    expect(await screen.findByText("the sample tasks")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/w/acme/samples", {});
  });

  it("offers a member neither the samples nor a project to make", () => {
    show("member");
    expect(screen.getByText("Create your first project")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try it with sample tasks" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Create a project" })).toBeNull();
  });
});
