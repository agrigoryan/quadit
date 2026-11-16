// @vitest-environment jsdom
// The relations section of a task's panel (detail/relations.tsx): a relation
// whose far end the server left blank, because it is a task of a project
// this person may not read, is drawn as a task they can't see.

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { emptyCollections } from "@/data/collections";
import { clearStore, useStore } from "@/data/store";
import { Relations } from "@/detail/relations";
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

function renderRelations(relations: Relation[]) {
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <Relations task={task(1)} relations={relations} />
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
});
