// @vitest-environment jsdom
// A project's cycles (plan/cycles-page.tsx): a cycle not yet ended shows its
// scope against what the latest ended cycles completed, in points where the
// project estimates and in tasks where it does not, marked when it is more;
// nothing while no cycle has ended or the finished tasks are still coming.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import { addDays } from "@/lib/days";
import { serverDay } from "@/lib/time";
import type { Member, ProjectSettings, Task, User, Workspace } from "@/types/core";
import { CyclesPage } from "@/insights/plan/cycles-page";
import { TooltipProvider } from "@/ui/tooltip";

const today = serverDay();
const day = (n: number) => addDays(today, n);
const task = (n: number, cycle: string, status: string, estimate?: number) =>
  ({ id: `t${n}`, key: `SVA-${n}`, project_id: "p1", cycle_id: cycle, status_id: status, estimate, rank: "a" }) as Task;

const TASKS = [task(1, "c1", "done", 5), task(2, "c1", "done", 3), task(3, "c2", "todo", 5), task(4, "c2", "todo", 5)];

/** `ended`: how many cycles have ended, the latest last. */
function show(settings: ProjectSettings | undefined, { ended = 1, restComing = false, tasks = TASKS } = {}) {
  const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a", settings: { cycles: true, ...settings } }],
    statuses: [
      { id: "todo", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
      { id: "done", project_id: "p1", name: "Done", category: "done", rank: "b" },
    ],
    cycles: [
      ...[
        { id: "c0", project_id: "p1", number: 0, starts_on: day(-34), ends_on: day(-21) },
        { id: "c1", project_id: "p1", number: 1, starts_on: day(-20), ends_on: day(-7) },
      ].slice(2 - ended),
      { id: "c2", project_id: "p1", number: 2, starts_on: day(-6), ends_on: day(7) },
      { id: "c3", project_id: "p1", number: 3, starts_on: day(8), ends_on: day(21) },
    ],
    tasks,
    ...(restComing ? { part: "open", rest: 4 } : {}),
  });
  render(
    <MemoryRouter initialEntries={["/acme/p/SVA/cycles"]}>
      <TooltipProvider>
        <Routes>
          <Route path="/:ws/p/:key/cycles" element={<CyclesPage />} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("a cycle's capacity", () => {
  it("is the points the ended cycles completed, against each cycle to come, marked where the scope is more", () => {
    show({ estimates: true });
    const over = screen.getByLabelText(/^10 of about 8 points/);
    expect(over).toHaveAccessibleName(
      "10 of about 8 points. More than the cycle is likely to hold. About what the last ended cycle completed",
    );
    expect(over).toHaveClass("text-wait");
    expect(screen.getByLabelText(/^0 of about 8 points/)).not.toHaveClass("text-wait");
    // The ended cycle shows its points done, not a capacity.
    expect(screen.getByText("8 of 8 points")).toBeInTheDocument();
  });

  it("is compared before it is rounded: a scope of 3 is over a mean of 2.5", () => {
    show(
      { estimates: true },
      {
        ended: 2,
        tasks: [task(1, "c1", "done", 2), task(2, "c0", "done", 3), task(3, "c2", "todo", 3)],
      },
    );
    expect(screen.getByLabelText(/^3 of about 3 points/)).toHaveClass("text-wait");
  });

  it("is in tasks where the project does not estimate", () => {
    show(undefined);
    expect(screen.getByLabelText(/^2 of about 2 tasks\. About/)).toBeInTheDocument();
    expect(screen.queryByText(/points/)).toBeNull();
  });

  it("is not shown while no cycle has ended", () => {
    show({ estimates: true }, { ended: 0 });
    expect(screen.queryByText(/of about/)).toBeNull();
  });

  it("is not shown while the finished tasks are still coming", () => {
    show({ estimates: true }, { restComing: true });
    expect(screen.queryByText(/of about/)).toBeNull();
  });
});
