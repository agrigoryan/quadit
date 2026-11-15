// @vitest-environment jsdom
// The sub-tasks section of a task's panel (detail/subtasks.tsx).

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import { emptyCollections } from "@/data/collections";
import { useStore } from "@/data/store";
import type { Member, Status, Task } from "@/types/core";
import { Subtasks } from "@/detail/subtasks";
import { TooltipProvider } from "@/ui/tooltip";

const status = (id: string, category: Status["category"]) => ({ id, name: id, category, project_id: "p" }) as Status;

const task = (n: number, statusId: string, parent?: string): Task => ({
  id: `t${n}`,
  project_id: "p",
  number: n,
  key: `SVA-${n}`,
  title: `Task ${n}`,
  status_id: statusId,
  parent_id: parent,
  priority: 0,
  rank: String(n),
  created_by: "u",
  created_at: 0,
  updated_at: 0,
  updated_seq: 0,
});

const parent = task(1, "todo");
const children = [task(2, "done", "t1"), task(3, "todo", "t1"), task(4, "canceled", "t1")];

beforeAll(() => {
  useStore.setState({
    slug: "test",
    collections: {
      ...emptyCollections(),
      statuses: Object.fromEntries(
        [status("todo", "unstarted"), status("done", "done"), status("canceled", "canceled")].map((s) => [s.id, s]),
      ),
      tasks: Object.fromEntries([parent, ...children].map((t) => [t.id, t])),
    },
  });
});

describe("Subtasks", () => {
  it("counts progress as the row's pill does: a canceled sub-task is in neither number", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Subtasks task={parent} subtasks={children} />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("progressbar", { name: "1 of 2 sub-tasks done" })).toBeTruthy();
    expect(screen.getByText("1 of 2 done")).toBeTruthy();
    // The canceled one is still listed.
    expect(screen.getByText("Task 4")).toBeTruthy();
  });

  it("offers a read-only member no way to change the sub-tasks", () => {
    const member = { user_id: "u", role: "member", name: "Ann", kind: "person", handle: "ann" } as Member;
    const draw = () =>
      render(
        <MemoryRouter>
          <TooltipProvider>
            <Subtasks task={parent} subtasks={children} />
          </TooltipProvider>
        </MemoryRouter>,
      );

    useStore.setState({ me: member });
    const writer = draw();
    expect(screen.getByRole("textbox", { name: "Add a sub-task" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove SVA-/ })).toHaveLength(3);
    writer.unmount();

    useStore.setState({ me: { ...member, scope: { read_only: true } } });
    draw();
    expect(screen.queryByRole("textbox", { name: "Add a sub-task" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Remove SVA-/ })).toHaveLength(0);
    for (const button of screen.getAllByRole("button", { name: /^Status/ }))
      expect(button).toHaveProperty("disabled", true);
  });
});
