// @vitest-environment jsdom
// The line under the comment box (detail/comment-reach.tsx): for a task
// assigned to an agent or waiting on one, what will happen to what is
// written, in each of the agent's three states, with the way to connect one
// that never has: the app's Connect in the desktop app, its page in
// Settings in a browser.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { CommentReach } from "@/detail/comment-reach";
import { WithQuery } from "@/test/query";
import type { Member, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const ann = { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member;
const codex = { user_id: "a1", handle: "codex", name: "Codex", kind: "agent", role: "member" } as Member;
const base = { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Boss" } as Task;

function load(agent: Member) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: ann,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", rank: "a" }],
    members: [ann, agent],
  });
}

/** What GET /agents/connection answers about @codex: whether it listens, and the tool of its last connect code. */
function agents(listening: boolean, tool?: string) {
  vi.spyOn(api, "get").mockResolvedValue({ agents: [{ user_id: "a1", handle: "@codex", listening, tool }] });
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
  vi.restoreAllMocks();
  delete window.quaditDesktop;
});

describe("the line under the comment box", () => {
  it("says an agent that is listening will see it", async () => {
    agents(true);
    show({ ...base, assignee_id: "a1" });
    expect(await screen.findByText("@codex is listening and will see this.")).toBeTruthy();
  });

  it("says when an agent that is not listening will see it, and what to say to it in a chat", async () => {
    agents(false, "Codex");
    show({ ...base, assignee_id: "u1", waiting_on_id: "a1" });
    expect(
      await screen.findByText(
        "@codex is not listening. To have it answer here, say “listen to Quadit” in Codex. Until then it sees this when you next ask it, for example “check Quadit”.",
      ),
    ).toBeTruthy();
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
