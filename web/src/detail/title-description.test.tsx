// @vitest-environment jsdom
// A task's title (detail/title-description.tsx): a text box for someone who
// may edit the task, plain words for someone who may not (a task in the
// trash, a member who may only read), and Shift+R that renames. Its
// description's task list is ticked in place, as an edit to undo.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearUndo, nextUndo, undo } from "@/data/undo";
import { Description, EditableTitle } from "@/detail/title-description";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import type { Member, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const TASK = { id: "t1", project_id: "p1", key: "SVA-1", title: "Fix the login" } as Task;

function seed(scope?: Member["scope"]) {
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "member", scope } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    tasks: [{ ...TASK, description: "- [ ] milk\n- [ ] eggs" }],
  });
}

beforeEach(() => clearStore());

describe("EditableTitle", () => {
  it("is a text box for someone who may edit the task", () => {
    seed();
    render(<EditableTitle task={TASK} />);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Fix the login");
  });

  it("is a heading, and no Tab stop, for a task in the trash", () => {
    seed();
    render(<EditableTitle task={{ ...TASK, deleted_at: 5 }} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading", { name: "Fix the login" })).not.toHaveAttribute("tabindex");
  });

  it("is a heading for a member who may only read", () => {
    seed({ read_only: true });
    render(<EditableTitle task={TASK} large />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Fix the login" })).toBeInTheDocument();
  });

  it("takes the caret with Shift+R, the whole title chosen, but not from a field", () => {
    seed();
    render(
      <>
        <input aria-label="field" />
        <EditableTitle task={TASK} />
      </>,
    );
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Title" });
    const field = screen.getByLabelText("field");
    field.focus();
    act(() => void fireEvent.keyDown(field, { key: "R", code: "KeyR", shiftKey: true }));
    expect(field).toHaveFocus();
    act(() => void fireEvent.keyDown(document.body, { key: "R", code: "KeyR", shiftKey: true }));
    expect(box).toHaveFocus();
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, "Fix the login".length]);
  });
});

describe("Description", () => {
  beforeEach(() => {
    vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) =>
      Promise.resolve({ results: (body as { changes: unknown[] }).changes.map(() => ({})) }),
    );
    clearUndo();
  });

  afterEach(async () => {
    await clearOutbox();
    vi.restoreAllMocks();
  });

  const shown = () => getState().collections.tasks.t1 as Task;
  const description = () =>
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Description task={shown()} loading={false} />
        </TooltipProvider>
      </MemoryRouter>,
    );

  it("ticks a box of its task list with a click, a step to undo", () => {
    seed();
    description();
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    expect(shown().description).toBe("- [ ] milk\n- [x] eggs");
    // A click on a box is not a click into the text to edit it.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(nextUndo()).toBeDefined();
    undo();
    expect(shown().description).toBe("- [ ] milk\n- [ ] eggs");
  });

  it("leaves the boxes as they are for a member who may only read", () => {
    seed({ read_only: true });
    description();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
  });
});
