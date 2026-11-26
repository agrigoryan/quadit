// @vitest-environment jsdom
// A card on the board (tasks/board-card.tsx) is built as a list's row is:
// the title is the link that opens the task, and the assignee's avatar is a
// button of its own beside it, not inside it. The avatar opens the card about
// the assignee for someone who may not change the task, and the assignee
// picker for someone who may.

import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { BoardCard } from "@/tasks/board-card";
import { WithQuery } from "@/test/query";
import type { Member, ProjectSettings, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const ann = { user_id: "u1", handle: "ann", name: "Ann Owner", kind: "person", role: "owner" } as Member;
const bot = { user_id: "u2", handle: "bot", name: "Build Bot", kind: "agent", role: "member" } as Member;
const task = {
  id: "t1",
  key: "SVA-1",
  project_id: "p1",
  status_id: "s1",
  title: "Boss",
  assignee_id: "u2",
  rank: "a",
} as Task;

function load(me: Member, settings?: ProjectSettings, shown: Task = task) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: me.user_id } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", rank: "a", settings }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    members: [ann, bot],
    tasks: [shown],
  });
}

beforeAll(() => {
  // The picker's list scrolls to its choice and measures itself; jsdom does neither.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.spyOn(api, "get").mockResolvedValue({ agents: [] });
});

afterEach(() => vi.restoreAllMocks());

function Address() {
  const { pathname } = useLocation();
  return <output aria-label="address">{pathname}</output>;
}

function show(shown: Task = task) {
  render(
    <MemoryRouter initialEntries={["/acme/p/SVA/board"]}>
      <WithQuery>
        <TooltipProvider>
          <DndContext>
            <SortableContext items={["todo|t1"]}>
              <Routes>
                <Route path="*" element={<BoardCard id="todo|t1" task={shown} />} />
              </Routes>
            </SortableContext>
          </DndContext>
          <Address />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

describe("a card on the board", () => {
  it("is an article whose title is the link that opens the task, with no control inside the link", () => {
    load(ann);
    show();
    const card = screen.getByRole("article");
    const link = screen.getByRole("link", { name: "SVA-1 Boss" });
    expect(card).toContainElement(link);
    expect(card).toHaveAttribute("data-task", "t1");
    expect(link).toHaveAttribute("data-task", "t1");
    expect(link.querySelector("button")).toBeNull();
    fireEvent.click(link);
    expect(screen.getByRole("status", { name: "address" })).toHaveTextContent("/acme/task/SVA-1");
  });

  it("opens the card about the assignee for someone who may not change the task", async () => {
    load({ ...ann, scope: { read_only: true } });
    show();
    expect(screen.queryByRole("button", { name: /^Assignee/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "About Build Bot" }));
    expect(await screen.findByRole("dialog", { name: "Build Bot" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "address" })).toHaveTextContent("/acme/p/SVA/board");
  });

  it("opens the assignee picker for someone who may change the task", async () => {
    load(ann);
    show();
    expect(screen.queryByRole("button", { name: "About Build Bot" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Assignee: Build Bot" }));
    expect(await screen.findByRole("dialog", { name: "Assign to…" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "address" })).toHaveTextContent("/acme/p/SVA/board");
  });

  it("shows the estimate where the project estimates: the size on a T-shirt project, 0 apart from none", () => {
    const sized = { ...task, estimate: 3 };
    load(ann, { estimates: true, estimate_scale: "tshirt" }, sized);
    show(sized);
    expect(screen.getByTitle("Estimate: M")).toHaveTextContent("M");
  });

  it("shows an estimate of 0 where 0 is an estimate", () => {
    const zero = { ...task, estimate: 0 };
    load(ann, { estimates: true, estimate_zero: true }, zero);
    show(zero);
    expect(screen.getByTitle("Estimate: 0 points")).toHaveTextContent("0");
  });

  it("shows no estimate where the project does not estimate", () => {
    const stale = { ...task, estimate: 5 };
    load(ann, undefined, stale);
    show(stale);
    expect(screen.queryByTitle(/^Estimate/)).toBeNull();
  });
});
