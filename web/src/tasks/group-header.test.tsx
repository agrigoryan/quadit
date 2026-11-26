// @vitest-environment jsdom
// A group's count (tasks/group-header.tsx GroupCount): the number of tasks,
// and, where the project in view estimates, its points too on hover and
// focus, which is also what the count is called.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Project, ProjectSettings, Task } from "@/types/core";
import type { TaskGroup } from "@/tasks/filters";
import { GroupCount } from "@/tasks/group-header";
import { TooltipProvider } from "@/ui/tooltip";

const task = (estimate?: number) => ({ id: `t${estimate}`, project_id: "p1", estimate }) as Task;
const group: TaskGroup = {
  id: "s1",
  title: "Todo",
  value: "s1",
  kind: "status",
  category: "unstarted",
  tasks: [task(5), task(0), task()],
};
const project = (settings?: ProjectSettings) => ({ id: "p1", key: "SVA", settings }) as Project;

function renderCount(settings?: ProjectSettings) {
  render(
    <TooltipProvider>
      <GroupCount group={group} project={project(settings)} />
    </TooltipProvider>,
  );
}

describe("GroupCount", () => {
  it("is the number of tasks, and nothing more, where the project does not estimate", () => {
    renderCount();
    expect(screen.getByText("3")).not.toHaveAttribute("tabindex");
    expect(screen.queryByLabelText(/points/)).toBeNull();
  });

  it("tells the tasks and their points where the project estimates, a task without an estimate as 1", async () => {
    renderCount({ estimates: true });
    const count = screen.getByLabelText("3 tasks, 6 points");
    expect(count).toHaveTextContent("3");
    act(() => count.focus());
    fireEvent.focus(count);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("3 tasks, 6 points");
  });

  it("counts a task without an estimate as nothing where the project says so", () => {
    renderCount({ estimates: true, estimate_ignore_unestimated: true });
    expect(screen.getByLabelText("3 tasks, 5 points")).toBeInTheDocument();
  });
});
