// @vitest-environment jsdom
// The task picker (detail/task-picker.tsx), used to pick a parent and the
// other side of a relation: it offers only tasks in use.

import { render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskPicker } from "@/detail/task-picker";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";

beforeAll(() => {
  // cmdk scrolls the active row into view and measures the list; jsdom does neither.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Ann", kind: "person", handle: "ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    tasks: [
      { id: "t1", key: "SVA-1", project_id: "p1", title: "live", updated_at: 3 },
      { id: "t2", key: "SVA-2", project_id: "p1", title: "trashed", updated_at: 2, deleted_at: 5 },
      { id: "t3", key: "SVA-3", project_id: "p1", title: "archived", updated_at: 1, archived_at: 6 },
    ],
  });
});

describe("TaskPicker", () => {
  it("offers neither a trashed nor an archived task", () => {
    render(
      <TaskPicker filter={() => true} label="Pick a task" onPick={() => {}} open>
        <button type="button">Pick</button>
      </TaskPicker>,
    );
    const options = within(screen.getByRole("listbox", { name: "Pick a task" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["liveSVA-1"]);
  });
});
