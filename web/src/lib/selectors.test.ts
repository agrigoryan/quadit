// @vitest-environment jsdom
// The read interface (lib/selectors.ts): lists hold live rows only, what is
// gone is reached by name, and an answer stays the same object until its
// rows change.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getRow,
  getRowEvenIfGone,
  getRows,
  getTaskByKey,
  getTaskByKeyEvenIfGone,
  isLive,
  projectByKey,
  useArchived,
  useCycles,
  useEpics,
  useLabels,
  useLiveTasks,
  useLookup,
  useLookupEvenIfGone,
  useMember,
  useMembers,
  useOpenDecisions,
  useProjects,
  useRow,
  useRowEvenIfGone,
  useRows,
  useSubtaskProgress,
  useStatuses,
  useTaskByKey,
  useTaskByKeyEvenIfGone,
  useTemplates,
  useTrashed,
  useTrashedTasks,
  useUnreadCount,
  useViews,
} from "@/lib/selectors";
import { type BootstrapData, clearStore, getState, loadBootstrap, patchRow } from "@/lib/store";
import type { Member, User, Workspace } from "@/types/core";

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;

/** A workspace with, of each kind, a live row and the ways a row can be gone. */
const fixture: BootstrapData = {
  seq: 1,
  me,
  user: { id: "u1" } as User,
  workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
  projects: [
    { id: "p1", key: "SVA", name: "Live", rank: "a" },
    { id: "p2", key: "OLD", name: "Archived", rank: "b", archived_at: 5 },
    { id: "p3", key: "BIN", name: "Trashed", rank: "c", deleted_at: 6 },
  ],
  tasks: [
    { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "live" },
    { id: "t2", key: "SVA-2", project_id: "p1", status_id: "s1", title: "trashed", deleted_at: 10 },
    { id: "t3", key: "SVA-3", project_id: "p1", status_id: "s1", title: "archived", archived_at: 11 },
    { id: "t4", key: "SVA-4", project_id: "p1", status_id: "s1", title: "trashed later", deleted_at: 20 },
  ],
  statuses: [
    { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
    { id: "s2", project_id: "p1", name: "Review", category: "started", rank: "b", deleted_at: 3 },
  ],
  labels: [
    { id: "l1", name: "bug" },
    { id: "l2", name: "old", deleted_at: 3 },
  ],
  members: [
    me,
    { user_id: "u2", role: "member", name: "Bea", kind: "person", handle: "bea" },
    { user_id: "u3", role: "member", name: "Gone", kind: "person", handle: "gone", removed_at: 4 },
  ],
  epics: [
    { id: "e1", project_id: "p1", name: "Launch", rank: "a" },
    { id: "e2", project_id: "p1", name: "Dropped", rank: "b", deleted_at: 3 },
  ],
  cycles: [
    { id: "c1", project_id: "p1", starts_on: "2026-01-01" },
    { id: "c2", project_id: "p1", starts_on: "2026-01-15", deleted_at: 3 },
  ],
  templates: [
    { id: "tp1", name: "Bug" },
    { id: "tp2", name: "Old", deleted_at: 3 },
  ],
  views: [
    { id: "v1", slug: "mine", name: "Mine", rank: "a" },
    { id: "v2", slug: "gone", name: "Gone", rank: "b", deleted_at: 3 },
  ],
  decisions: [
    { id: "d1", task_id: "t1", state: "open" },
    { id: "d2", task_id: "t1", state: "open", deleted_at: 3 },
    { id: "d3", task_id: "t1", state: "picked" },
  ],
  notifications: [
    { id: "n1", user_id: "u1" },
    { id: "n2", user_id: "u1", archived_at: 3 },
    { id: "n3", user_id: "u2" },
  ],
  docs: [
    { id: "doc1", title: "Live" },
    { id: "doc2", title: "Archived", archived_at: 3 },
    { id: "doc3", title: "Trashed", deleted_at: 3 },
  ],
};

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", fixture);
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const hook = <T>(use: () => T) => renderHook(use).result.current;

describe("isLive", () => {
  it("is false for a row in the trash, an archived one and a removed member", () => {
    expect(isLive({})).toBe(true);
    expect(isLive({ deleted_at: 1 })).toBe(false);
    expect(isLive({ archived_at: 1 })).toBe(false);
    expect(isLive({ removed_at: 1 })).toBe(false);
  });
});

describe("lists hold live rows only", () => {
  it("useRows and getRows", () => {
    expect(ids(hook(() => useRows("tasks")))).toEqual(["t1"]);
    expect(ids(getRows("docs"))).toEqual(["doc1"]);
    expect(hook(() => useRows("members")).map((m) => m.user_id)).toEqual(["u1", "u2"]);
  });

  it("the named lists", () => {
    expect(ids(hook(useLiveTasks))).toEqual(["t1"]);
    expect(ids(hook(useProjects))).toEqual(["p1"]);
    expect(ids(hook(() => useStatuses("p1")))).toEqual(["s1"]);
    expect(ids(hook(() => useLabels("p1")))).toEqual(["l1"]);
    expect(hook(useMembers).map((m) => m.name)).toEqual(["Bea", "Me"]);
    expect(ids(hook(() => useEpics("p1")))).toEqual(["e1"]);
    expect(ids(hook(() => useCycles("p1")))).toEqual(["c1"]);
    expect(ids(hook(() => useTemplates("p1")))).toEqual(["tp1"]);
    expect(ids(hook(useViews))).toEqual(["v1"]);
    expect(Object.keys(hook(useOpenDecisions))).toEqual(["t1"]);
    expect(ids(hook(useOpenDecisions).t1 ?? [])).toEqual(["d1"]);
    expect(hook(useUnreadCount)).toBe(1);
  });

  it("useLookup has the live rows by id, useLookupEvenIfGone all of them", () => {
    expect(Object.keys(hook(() => useLookup("statuses")))).toEqual(["s1"]);
    expect(Object.keys(hook(() => useLookupEvenIfGone("statuses"))).sort()).toEqual(["s1", "s2"]);
    expect(Object.keys(hook(() => useLookup("members"))).sort()).toEqual(["u1", "u2"]);
  });
});

describe("what is gone is reached by name", () => {
  it("useTrashed and useTrashedTasks: the trash, the most recently trashed first", () => {
    expect(hook(useTrashedTasks).map((t) => t.id)).toEqual(["t4", "t2"]);
    expect(ids(hook(() => useTrashed("projects")))).toEqual(["p3"]);
    expect(ids(hook(() => useTrashed("docs")))).toEqual(["doc3"]);
  });

  it("useArchived: archived and not in the trash", () => {
    expect(ids(hook(() => useArchived("tasks")))).toEqual(["t3"]);
    expect(ids(hook(() => useArchived("projects")))).toEqual(["p2"]);
  });

  it("one row by id: useRow only when live, useRowEvenIfGone whatever became of it", () => {
    expect(hook(() => useRow("tasks", "t1"))?.id).toBe("t1");
    expect(hook(() => useRow("tasks", "t2"))).toBeUndefined();
    expect(hook(() => useRow("tasks", "t3"))).toBeUndefined();
    expect(hook(() => useRow("members", "u3"))).toBeUndefined();
    expect(hook(() => useRowEvenIfGone("tasks", "t2"))?.id).toBe("t2");
    expect(hook(() => useRowEvenIfGone("statuses", "s2"))?.name).toBe("Review");
    expect(getRow("tasks", "t3")).toBeUndefined();
    expect(getRowEvenIfGone("tasks", "t3")?.id).toBe("t3");
    expect(hook(() => useRow("tasks", undefined))).toBeUndefined();
  });

  it("useMember names a removed member: what they did keeps their name", () => {
    expect(hook(() => useMember("u3"))?.name).toBe("Gone");
  });

  it("a task by key, in the trash or the archive too, for its own page", () => {
    expect(hook(() => useTaskByKeyEvenIfGone("sva-2"))?.id).toBe("t2");
    expect(getTaskByKeyEvenIfGone("SVA-3")?.id).toBe("t3");
    expect(getTaskByKeyEvenIfGone("SVA-9")).toBeUndefined();
  });

  it("projectByKey finds an archived project, case aside, and not one in the trash", () => {
    expect(projectByKey(getState().collections.projects, "old")?.id).toBe("p2");
    expect(projectByKey(getState().collections.projects, "BIN")).toBeUndefined();
  });

  it("useTaskByKey finds a live task only", () => {
    expect(hook(() => useTaskByKey("sva-1"))?.id).toBe("t1");
    expect(hook(() => useTaskByKey("SVA-2"))).toBeUndefined();
    expect(hook(() => useTaskByKey("SVA-3"))).toBeUndefined();
    expect(getTaskByKey("SVA-3")).toBeUndefined();
  });
});

describe("useSubtaskProgress", () => {
  it("counts the sub-tasks the list shows: not a trashed or an archived one", () => {
    loadBootstrap("acme", {
      ...fixture,
      tasks: [
        { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "parent" },
        { id: "t5", key: "SVA-5", project_id: "p1", status_id: "s1", parent_id: "t1", title: "live" },
        { id: "t6", key: "SVA-6", project_id: "p1", status_id: "s1", parent_id: "t1", title: "x", deleted_at: 1 },
        { id: "t7", key: "SVA-7", project_id: "p1", status_id: "s1", parent_id: "t1", title: "y", archived_at: 1 },
      ],
    });
    expect(hook(() => useSubtaskProgress("t1"))).toEqual({ done: 0, total: 1 });
  });
});

describe("answers are stable", () => {
  it("a list is the same array until a row of its collection changes", () => {
    const { result, rerender } = renderHook(() => ({
      tasks: useRows("tasks"),
      projects: useProjects(),
      lookup: useLookup("statuses"),
      trash: useTrashedTasks(),
    }));
    const first = result.current;
    rerender();
    expect(result.current.tasks).toBe(first.tasks);
    act(() => patchRow("labels", "l1", { name: "defect" }));
    expect(result.current.tasks).toBe(first.tasks);
    expect(result.current.projects).toBe(first.projects);
    expect(result.current.lookup).toBe(first.lookup);
    expect(result.current.trash).toBe(first.trash);
    act(() => patchRow("tasks", "t1", { deleted_at: 30 }));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.trash.map((t) => t.id)).toEqual(["t1", "t4", "t2"]);
  });

  it("a shared list cannot be sorted in place under its other readers", () => {
    const rows = getRows("members");
    expect(() => rows.reverse()).toThrow(TypeError);
  });

  it("a component that lists rows renders once per change, not in a loop", () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return [useRows("tasks"), useLookup("members"), useTrashed("docs")];
    });
    expect(renders).toBe(1);
  });
});
