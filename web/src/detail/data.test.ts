// @vitest-environment jsdom
// What the task panel reads (detail/data.ts): the lists on a task hold only
// what is in use.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSubtasks } from "@/detail/data";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Ann", kind: "person", handle: "ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    tasks: [
      { id: "t1", key: "SVA-1", project_id: "p1", title: "parent", rank: "a" },
      { id: "t2", key: "SVA-2", project_id: "p1", title: "live", parent_id: "t1", rank: "b" },
      { id: "t3", key: "SVA-3", project_id: "p1", title: "trashed", parent_id: "t1", rank: "c", deleted_at: 5 },
      { id: "t4", key: "SVA-4", project_id: "p1", title: "archived", parent_id: "t1", rank: "d", archived_at: 6 },
    ],
  });
});

describe("useSubtasks", () => {
  it("lists neither a trashed nor an archived sub-task", () => {
    const { result } = renderHook(() => useSubtasks("t1"));
    expect(result.current.map((tk) => tk.title)).toEqual(["live"]);
  });
});
