// What a template fills in on the create dialog (tasks/template-preset.ts).

import { beforeEach, describe, expect, it } from "vitest";
import { type BootstrapData, clearStore, loadBootstrap } from "@/data/store";
import type { Member, Project, Template, User, Workspace } from "@/types/core";
import { presetOf } from "@/tasks/template-preset";

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
const project = { id: "p1", key: "SVA", name: "Live", rank: "a" } as Project;

const fixture: BootstrapData = {
  seq: 1,
  me,
  user: { id: "u1" } as User,
  workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
  projects: [project],
  statuses: [
    { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
    { id: "s2", project_id: "p1", name: "Review", category: "started", rank: "b", deleted_at: 3 },
  ],
  labels: [
    { id: "l1", name: "bug" },
    { id: "l2", name: "old", deleted_at: 3 },
  ],
  members: [me, { user_id: "u3", role: "member", name: "Gone", kind: "person", handle: "gone", removed_at: 4 }],
};

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", fixture);
});

const preset = (p: Template["preset"]) =>
  presetOf({ id: "tp", name: "T", preset: p, created_at: 0, updated_seq: 0 }, project);

describe("presetOf", () => {
  it("fills in what the template names", () => {
    expect(preset({ status: "todo", labels: ["BUG"], assignee: "@me", priority: 2 })).toEqual({
      statusId: "s1",
      labelIds: ["l1"],
      assigneeId: "u1",
      priority: 2,
    });
  });

  it("leaves the estimate to the server, which applies the template's as it is stored", () => {
    expect(preset({ estimate: 5, priority: 1 })).toEqual({ priority: 1 });
  });

  it("leaves out a deleted status, a deleted label and someone removed from the workspace", () => {
    expect(preset({ status: "Review", labels: ["old"], assignee: "@gone" })).toEqual({ labelIds: [] });
  });
});
