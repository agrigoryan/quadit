// @vitest-environment jsdom
// A project's labels (settings/projects/labels.tsx): how many tasks carry
// each, and who may change them.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, Project, User, Workspace } from "@/types/core";
import { ProjectLabels } from "@/settings/projects/labels";
import { TooltipProvider } from "@/ui/tooltip";

const project = { id: "p1", key: "SVA", name: "Live", rank: "a" } as Project;

function seed(me: Member) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: me.user_id } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    projects: [project],
    labels: [
      { id: "l1", project_id: "p1", name: "bug" },
      { id: "l2", project_id: "p1", name: "dropped", deleted_at: 3 },
    ],
    tasks: [
      { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", label_ids: ["l1"] },
      { id: "t2", key: "SVA-2", project_id: "p1", status_id: "s1", label_ids: ["l1"], archived_at: 5 },
      { id: "t3", key: "SVA-3", project_id: "p1", status_id: "s1", label_ids: ["l1"], deleted_at: 6 },
    ],
  });
}

const person = (role: Member["role"], scope?: Member["scope"]) =>
  ({ user_id: "u1", role, name: "Me", kind: "person", handle: "me", scope }) as Member;

const show = () =>
  render(
    <TooltipProvider>
      <ProjectLabels project={project} />
    </TooltipProvider>,
  );

const changeControls = () => [
  screen.queryByRole("button", { name: "Colour of bug" }),
  screen.queryByRole("button", { name: "Delete: bug" }),
  screen.queryByDisplayValue("bug"),
];

describe("ProjectLabels", () => {
  beforeEach(() => seed(person("admin")));

  it("lists live labels and counts tasks out of the trash, archived ones included", () => {
    show();
    expect(screen.queryByText("dropped")).toBeNull();
    expect(screen.queryByDisplayValue("dropped")).toBeNull();
    expect(screen.getByText("2 tasks")).toBeTruthy();
  });

  it("lets an admin rename, recolour and delete", () => {
    show();
    for (const control of changeControls()) expect(control).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add label" })).toBeTruthy();
  });

  it("offers a plain member only a new label", () => {
    seed(person("member"));
    show();
    for (const control of changeControls()) expect(control).toBeNull();
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add label" })).toBeTruthy();
  });

  it("offers a read-only admin nothing to change", () => {
    seed(person("admin", { read_only: true }));
    show();
    for (const control of changeControls()) expect(control).toBeNull();
    expect(screen.queryByRole("button", { name: "Add label" })).toBeNull();
  });
});
