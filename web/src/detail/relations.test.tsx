// @vitest-environment jsdom
// The relations section of a task's panel (detail/relations.tsx): a relation
// whose far end the server left blank, because it is a task of a project
// this person may not read, is drawn as a task they can't see; and the form
// that adds one, as a key opens it (M then a letter).

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { emptyCollections } from "@/data/collections";
import { clearStore, useStore } from "@/data/store";
import { type Adding, Relations } from "@/detail/relations";
import { WithQuery } from "@/test/query";
import type { Member, Relation, Status, Task } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const task = (n: number): Task => ({
  id: `t${n}`,
  project_id: "p",
  number: n,
  key: `SVA-${n}`,
  title: `Task ${n}`,
  status_id: "todo",
  priority: 0,
  rank: String(n),
  created_by: "u",
  created_at: 0,
  updated_at: 0,
  created_seq: 0,
  updated_seq: 0,
  activity_seq: 0,
});

const relation = (id: string, taskId: string, type: Relation["type"], relatedId: string): Relation => ({
  id,
  task_id: taskId,
  related_task_id: relatedId,
  type,
  created_by: "u",
  created_at: 0,
});

beforeAll(() => {
  // jsdom has no layout: nothing is ever resized, nor scrolled.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  clearStore();
  useStore.setState({
    slug: "test",
    me: { user_id: "u", role: "member", scope: { projects: ["p"] } } as Member,
    collections: {
      ...emptyCollections(),
      statuses: { todo: { id: "todo", name: "Todo", category: "unstarted", project_id: "p" } as Status },
      tasks: { t1: task(1), t2: task(2) },
    },
  });
});

afterEach(() => vi.restoreAllMocks());

function renderRelations(relations: Relation[], adding: Adding | null = null) {
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <Relations task={task(1)} relations={relations} adding={adding} onAdd={() => {}} onAddDone={() => {}} />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

describe("Relations", () => {
  it("draws a relation whose far end is blank as a task you can't see, with nothing to open or remove", () => {
    const get = vi.spyOn(api, "get");
    renderRelations([
      relation("r1", "t1", "blocks", "t2"),
      relation("r2", "", "duplicates", "t1"),
      relation("r3", "t1", "relates", ""),
    ]);

    const blocks = screen.getByRole("list", { name: "Blocks" });
    expect(within(blocks).getByRole("link", { name: "Task 2" })).toBeTruthy();
    expect(within(blocks).getByRole("button", { name: "Remove the relation to SVA-2" })).toBeTruthy();

    for (const heading of ["Relates to", "Duplicated by"]) {
      const group = screen.getByRole("list", { name: heading });
      expect(within(group).getByText("A task you can't see")).toBeTruthy();
      expect(within(group).queryByRole("link")).toBeNull();
      expect(within(group).queryByRole("button")).toBeNull();
    }
    // There is no task to fetch for the blank end.
    expect(get).not.toHaveBeenCalled();
  });

  it("opens the form a key asked for with its kind chosen and the list of tasks open, and adds what is picked", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ results: [{}] });
    renderRelations([], { type: "blocked_by", pick: true, n: 1 });
    // The kind is chosen, and the list of tasks is open in front of it.
    expect(screen.getByRole("button", { name: "Blocked by" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Task 2/ }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0]?.[1] as { changes: { type: string; args: Record<string, unknown> }[] } | undefined;
    expect(body?.changes.map(({ type, args }) => ({ type, args }))).toEqual([
      { type: "relation.add", args: expect.objectContaining({ task: "t1", type: "blocked_by", other: "t2" }) },
    ]);
    await clearOutbox();
  });
});
