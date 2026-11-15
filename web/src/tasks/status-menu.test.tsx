// @vitest-environment jsdom
// Deleting a status from its column (tasks/status-menu.tsx): the dialog asks
// where the status's tasks go before the server has to, counting them the
// way the server does, the ones in the trash included.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { clearOutbox } from "@/lib/mutate";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, Project, Status, User, Workspace } from "@/types/core";
import { StatusMenu } from "@/tasks/status-menu";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const project = { id: "p1", key: "SVA", name: "Game" } as Project;
const todo = { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", is_default: true, rank: "a" } as Status;
const polish = { id: "s2", project_id: "p1", name: "Polish", category: "started", rank: "b" } as Status;

/** How many tasks the server says have the status: those not in the trash, and those in it. */
let counts = { kept: 0, trashed: 0 };

beforeEach(() => {
  counts = { kept: 0, trashed: 0 };
  vi.spyOn(api, "get").mockImplementation((path: string) =>
    Promise.resolve({ count: path.includes("trash=1") ? counts.trashed : counts.kept }),
  );
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [project],
    statuses: [todo, polish],
    members: [{ user_id: "u1", handle: "ann", name: "Ann" }],
  });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

function openDelete(status: Status) {
  render(
    <WithQuery>
      <TooltipProvider>
        <StatusMenu status={status} project={project} onRename={() => {}} />
      </TooltipProvider>
    </WithQuery>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: `Status options: ${status.name}` }), { key: "Enter" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
}

describe("deleting a status", () => {
  it("asks where the tasks go when the only ones left are in the trash, and says they move too", async () => {
    counts = { kept: 0, trashed: 2 };
    openDelete(polish);
    expect(await screen.findByRole("button", { name: "Move tasks and delete" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Move its tasks to" })).toBeInTheDocument();
    expect(screen.getByText(/2 tasks in the trash, which move too/)).toBeInTheDocument();
  });

  it("asks where the tasks go when tasks outside the trash have the status", async () => {
    counts = { kept: 1, trashed: 0 };
    openDelete(polish);
    expect(await screen.findByRole("button", { name: "Move tasks and delete" })).toBeInTheDocument();
    expect(screen.getByText("One task has this status: pick where it goes.")).toBeInTheDocument();
    expect(screen.queryByText(/in the trash/)).not.toBeInTheDocument();
  });

  it("asks which status takes the default's place, even with no tasks", async () => {
    openDelete(todo);
    expect(await screen.findByRole("button", { name: "Move tasks and delete" })).toBeInTheDocument();
  });

  it("deletes straight away a status no task has", async () => {
    openDelete(polish);
    await screen.findByText("No task has this status.");
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Move its tasks to" })).not.toBeInTheDocument();
  });
});
