// @vitest-environment jsdom
// A task's title (detail/title-description.tsx): a text box for someone who
// may edit the task, plain words for someone who may not (a task in the
// trash, a member who may only read).

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { EditableTitle } from "@/detail/title-description";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, Task, User, Workspace } from "@/types/core";

const TASK = { id: "t1", project_id: "p1", key: "SVA-1", title: "Fix the login" } as Task;

function seed(scope?: Member["scope"]) {
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "member", scope } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
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
});
