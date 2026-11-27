// @vitest-environment jsdom
// A task's row (tasks/task-row.tsx): its due date opens the date picker, and
// clearing the date there, which takes the date and its button off the row,
// leaves the focus on the row rather than nowhere.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { useRow } from "@/data/selectors";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { dueLabel } from "@/lib/time";
import type { Member, User, Workspace } from "@/types/core";
import { TaskRow } from "@/tasks/task-row";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) =>
    Promise.resolve({ results: (body as { changes: unknown[] }).changes.map(() => ({})) }),
  );
  vi.spyOn(api, "get").mockReturnValue(new Promise(() => {}));
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    members: [{ user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" }],
    tasks: [
      {
        id: "t1",
        project_id: "p1",
        number: 1,
        key: "SVA-1",
        title: "First",
        status_id: "s1",
        priority: 0,
        rank: "a",
        due_on: "2026-12-01",
      },
    ],
  });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

function Row() {
  const task = useRow("tasks", "t1");
  return task ? <TaskRow task={task} /> : null;
}

describe("a task row's due date", () => {
  it("leaves the focus on the row when it is cleared from the row", async () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Row />
        </TooltipProvider>
      </MemoryRouter>,
      { wrapper: WithQuery },
    );
    fireEvent.click(screen.getByRole("button", { name: `Due date: ${dueLabel("2026-12-01").text}` }));
    const picker = screen.getByRole("dialog", { name: "Set due date…" });
    fireEvent.click(within(picker).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(getState().collections.tasks.t1?.due_on).toBeUndefined();
    await waitFor(() => expect(screen.getByRole("link", { name: "Open SVA-1" })).toHaveFocus());
  });
});
