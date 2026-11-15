// @vitest-environment jsdom
// A project's preferences (settings/projects/preferences.tsx) name the
// labels they apply to: a label in the trash is not named.

import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, Project, User, Workspace } from "@/lib/types";
import { ProjectPreferences } from "@/settings/projects/preferences";

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
const project = { id: "p1", key: "SVA", name: "Live", rank: "a" } as Project;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    projects: [project],
    labels: [
      { id: "l1", name: "bug" },
      { id: "l2", name: "dropped", deleted_at: 3 },
    ],
    members: [me, { user_id: "u2", role: "member", name: "Gone", kind: "person", handle: "gone", removed_at: 4 }],
    preferences: [
      { id: "pr1", project_id: "p1", body: "Write tests", label_ids: ["l1", "l2"], created_by: "u2", created_at: 1 },
    ],
  });
});

it("names the live labels of a preference, not a trashed one", () => {
  render(<ProjectPreferences project={project} admin={false} />);
  expect(screen.getByText("bug")).toBeTruthy();
  expect(screen.queryByText("dropped")).toBeNull();
});

it("still names who wrote it after they were removed", () => {
  render(<ProjectPreferences project={project} admin={false} />);
  expect(screen.getByText("Gone")).toBeTruthy();
});
