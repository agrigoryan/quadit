// What a new task starts with on the page in view (nav/project-in-view.ts):
// C on an epic's or a cycle's page makes a task of that epic or cycle.

import type { Location } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import { draftInView } from "@/nav/project-in-view";

const at = (pathname: string) => ({ pathname, search: "", hash: "", state: null, key: "k" }) as Location;

beforeEach(() => {
  const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    projects: [
      { id: "p1", key: "SVA", name: "Live", rank: "a" },
      { id: "p2", key: "OPS", name: "Ops", rank: "b" },
    ],
    epics: [{ id: "e1", project_id: "p1", name: "Launch", state: "active", rank: "a" }],
    cycles: [{ id: "c1", project_id: "p1", number: 3, starts_on: "2026-11-02", ends_on: "2026-11-15" }],
  });
});

describe("draftInView", () => {
  it("puts a new task in the project in view", () => {
    expect(draftInView(at("/acme/p/OPS/tasks"))).toEqual({ projectId: "p2" });
  });

  it("puts it in the epic of an epic's page", () => {
    expect(draftInView(at("/acme/p/SVA/epics/e1"))).toEqual({ projectId: "p1", epicId: "e1" });
  });

  it("puts it in the cycle of a cycle's page", () => {
    expect(draftInView(at("/acme/p/SVA/cycles/c1"))).toEqual({ projectId: "p1", cycleId: "c1" });
  });

  it("leaves out an epic that is not the project's", () => {
    expect(draftInView(at("/acme/p/OPS/epics/e1"))).toEqual({ projectId: "p2" });
  });
});
