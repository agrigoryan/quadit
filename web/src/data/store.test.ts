// The browser's copy of a workspace (data/store.ts): feed events, the starting
// copy and its second part.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyEvents,
  type BootstrapData,
  clearStore,
  getState,
  loadBootstrap,
  markDrafts,
  markOpened,
  mergeRest,
  mergeRows,
  onReplaced,
} from "@/data/store";
import type { FeedEvent, Member, User, Workspace } from "@/types/core";

const me = { user_id: "u1", role: "member", name: "Me" } as Member;
const base = {
  me,
  user: { id: "u1" } as User,
  workspace: { id: "w", slug: "acme", name: "Acme", seq: 0 } as Workspace,
};

const event = (seq: number, over: Partial<FeedEvent>): FeedEvent => ({
  seq,
  at: 1000 + seq,
  actor_id: "u1",
  change_id: `c${seq}`,
  type: "task.updated",
  entity_type: "task",
  entity_id: "t1",
  scope_type: "",
  scope_id: "",
  data: {},
  ...over,
});
const retitle = (seq: number, id: string, to: string) =>
  event(seq, { entity_id: id, data: { changes: { title: { from: "", to } } } });

const boot = (over: Partial<BootstrapData> = {}): BootstrapData => ({ seq: 10, ...base, ...over });

beforeEach(() => clearStore());

describe("applyEvents", () => {
  it("moves seq only for events from the stream", () => {
    loadBootstrap("acme", boot({ tasks: [{ id: "t1", title: "a" }] }));
    applyEvents([retitle(11, "t1", "b")], false);
    expect(getState().collections.tasks.t1?.title).toBe("b");
    expect(getState().seq).toBe(10);
    applyEvents([retitle(13, "t1", "d"), retitle(12, "t1", "c")], true);
    expect(getState().seq).toBe(13);
  });

  it("does not apply again, in its place in the stream, an event a write was already answered with", () => {
    loadBootstrap("acme", boot({ tasks: [{ id: "t1", title: "a" }] }));
    const title = () => getState().collections.tasks.t1?.title;
    // Two of this tab's writes are answered, each with its event, ahead of the stream.
    applyEvents([retitle(11, "t1", "first")], false);
    applyEvents([retitle(13, "t1", "second")], false);
    expect(title()).toBe("second");
    // The stream now delivers the first in its place: the row must not go back to it, even for a moment.
    applyEvents([retitle(11, "t1", "first")], true);
    expect(title()).toBe("second");
    expect(getState().seq).toBe(11);
    applyEvents([retitle(13, "t1", "second")], true);
    expect(title()).toBe("second");
    expect(getState().seq).toBe(13);
  });

  it("drops events at or below the position already applied", () => {
    loadBootstrap("acme", boot({ tasks: [{ id: "t1", title: "a" }] }));
    applyEvents([event(10, { data: { gone: true } }), retitle(9, "t1", "old"), retitle(11, "t1", "b")], true);
    expect(getState().collections.tasks.t1?.title).toBe("b");
    const before = getState().collections;
    applyEvents([retitle(11, "t1", "again")], true);
    expect(getState().collections).toBe(before);
  });

  it("confirms a draft when the server's row for it arrives, and only that draft", () => {
    loadBootstrap("acme", boot());
    markDrafts("tasks", ["t5", "t6"]);
    applyEvents([event(11, { entity_id: "t5", data: { row: { id: "t5", number: 7 } } })], true);
    expect(getState().drafts).toEqual({ t6: "tasks" });
    expect(getState().collections.tasks.t5?.number).toBe(7);
  });

  it("follows the signed-in member's own row, and no one else's", () => {
    loadBootstrap("acme", boot({ members: [{ ...me }, { user_id: "u2", role: "member" }] }));
    applyEvents(
      [event(11, { entity_type: "member", entity_id: "u2", data: { row: { user_id: "u2", role: "admin" } } })],
      true,
    );
    expect(getState().me?.role).toBe("member");
    applyEvents(
      [event(12, { entity_type: "member", entity_id: "u1", data: { row: { ...me, role: "admin", name: "New" } } })],
      true,
    );
    expect(getState().me).toMatchObject({ user_id: "u1", role: "admin", name: "New" });
  });

  it("applies a workspace change to the workspace, not to a collection", () => {
    loadBootstrap("acme", boot());
    applyEvents(
      [
        event(11, {
          entity_type: "workspace",
          entity_id: "w",
          data: { changes: { name: { from: "Acme", to: "Acme Co" } } },
        }),
      ],
      true,
    );
    expect(getState().workspace?.name).toBe("Acme Co");
    expect(getState().seq).toBe(11);
  });
});

describe("loadBootstrap", () => {
  const first = () =>
    loadBootstrap(
      "acme",
      boot({
        tasks: [
          { id: "t1", title: "open" },
          { id: "t2", title: "will vanish" },
          { id: "t3", title: "in the trash", deleted_at: 5 },
        ],
        comments: [{ id: "k1", subject_id: "t1" }],
        projects: [
          { id: "p1", key: "SVA" },
          { id: "p2", key: "OPS" },
        ],
      }),
    );

  it("keeps across a reload what the starting copy leaves out, and drops what the server no longer sends", () => {
    first();
    // Opening a task fetched its description.
    applyEvents([event(11, { data: { row: { id: "t1", title: "open", description: "long text" } } })], true);
    markOpened("t1");
    applyEvents([event(12, { entity_id: "t9", data: { row: { id: "t9", title: "made here" } } })], false);
    // A task made here, not yet confirmed.
    applyEvents([event(13, { entity_id: "t8", data: { row: { id: "t8", title: "draft" } } })], false);
    markDrafts("tasks", ["t8"]);

    loadBootstrap("acme", boot({ seq: 20, tasks: [{ id: "t1", title: "open" }] }));
    const { collections: c, drafts, opened, seq } = getState();
    expect(seq).toBe(20);
    expect(c.tasks.t1?.description).toBe("long text");
    expect(c.comments.k1).toBeDefined();
    expect(c.tasks.t3?.deleted_at).toBe(5);
    expect(c.tasks.t8?.title).toBe("draft");
    expect(drafts).toEqual({ t8: "tasks" });
    expect(opened).toEqual({ t1: true });
    expect(c.tasks.t2).toBeUndefined();
    expect(c.tasks.t9).toBeUndefined();
  });

  it("keeps nothing for another workspace, or when asked to start fresh, and names the projects lost", () => {
    first();
    markOpened("t1");
    loadBootstrap("acme", boot({ tasks: [], projects: [{ id: "p1", key: "SVA" }] }), { fresh: true });
    expect(getState().collections.tasks).toEqual({});
    expect(getState().collections.comments).toEqual({});
    expect(getState().opened).toEqual({});
    expect(getState().lostProjects).toEqual(["OPS"]);

    loadBootstrap("other", boot({ tasks: [] }));
    expect(getState().lostProjects).toEqual([]);
  });

  it("says the finished work is still on its way when only the open part came", () => {
    loadBootstrap("acme", boot({ part: "open", rest: 3 }));
    expect(getState().restLoaded).toBe(false);
    loadBootstrap("acme", boot({ part: "open", rest: 0 }));
    expect(getState().restLoaded).toBe(true);
  });
});

describe("mergeRest", () => {
  it("lets the newer copy of a row win by updated_seq, and keeps an opened task's description", () => {
    loadBootstrap(
      "acme",
      boot({
        part: "open",
        rest: 2,
        tasks: [
          { id: "t1", title: "changed by the feed", updated_seq: 12 },
          { id: "t2", title: "old", description: "fetched", updated_seq: 5 },
          { id: "t3", title: "no stamp" },
        ],
      }),
    );
    mergeRest(
      "acme",
      {
        seq: 10,
        tasks: [
          { id: "t1", title: "stale", updated_seq: 8 },
          { id: "t2", title: "newer", updated_seq: 9 },
          { id: "t3", title: "stamped", updated_seq: 9 },
          { id: "t4", title: "finished" },
        ],
      },
      [],
    );
    const { tasks } = getState().collections;
    expect(tasks.t1?.title).toBe("changed by the feed");
    expect(tasks.t2).toMatchObject({ title: "newer", description: "fetched" });
    expect(tasks.t3?.title).toBe("no stamp");
    expect(tasks.t4?.title).toBe("finished");
    expect(getState().restLoaded).toBe(true);
  });

  it("applies again, over the rows it brings, the events past its own position", () => {
    loadBootstrap("acme", boot({ part: "open", rest: 1, tasks: [] }));
    const meanwhile = [retitle(11, "t9", "b"), retitle(13, "t8", "after")];
    applyEvents(meanwhile, true);
    // The second part was read at 12: it already holds t9's later title.
    const missing = mergeRest(
      "acme",
      {
        seq: 12,
        tasks: [
          { id: "t9", title: "c", updated_seq: 12 },
          { id: "t8", title: "before", updated_seq: 3 },
        ],
      },
      meanwhile,
    );
    expect(getState().collections.tasks.t9?.title).toBe("c");
    expect(getState().collections.tasks.t8?.title).toBe("after");
    expect(missing).toEqual([]);
  });

  it("returns the tasks events named that are in neither part", () => {
    loadBootstrap("acme", boot({ part: "open", rest: 1, tasks: [] }));
    const meanwhile = [retitle(11, "t7", "reopened")];
    applyEvents(meanwhile, true);
    expect(mergeRest("acme", { seq: 10, tasks: [] }, meanwhile)).toEqual(["t7"]);
  });

  it("does nothing for another workspace", () => {
    loadBootstrap("acme", boot({ part: "open", rest: 1, tasks: [] }));
    expect(mergeRest("other", { seq: 10, tasks: [{ id: "t1" }] }, [])).toEqual([]);
    expect(getState().collections.tasks).toEqual({});
    expect(getState().restLoaded).toBe(false);
  });
});

describe("mergeRows", () => {
  it("takes a fetched row, and what it carries that the lists leave out", () => {
    loadBootstrap("acme", boot({ tasks: [{ id: "t1", title: "old", updated_seq: 5 }] }));
    mergeRows("tasks", [{ id: "t1", title: "newer", description: "whole", updated_seq: 9 } as never]);
    expect(getState().collections.tasks.t1).toMatchObject({ title: "newer", description: "whole", updated_seq: 9 });
  });

  it("does not undo a change that came through the feed while the row was being fetched", () => {
    loadBootstrap("acme", boot({ tasks: [{ id: "t1", title: "old", updated_seq: 5 }] }));
    applyEvents([retitle(12, "t1", "changed by the feed")], true);
    // Read before that change, answered after it.
    mergeRows("tasks", [{ id: "t1", title: "old", description: "whole", updated_seq: 5 } as never]);
    expect(getState().collections.tasks.t1).toMatchObject({
      title: "changed by the feed",
      description: "whole",
      updated_seq: 12,
    });
  });
});

describe("mergeRows on a row of any kind", () => {
  it("does not undo a feed change to a database view fetched before it", () => {
    loadBootstrap("acme", boot());
    mergeRows("dbviews", [{ id: "v1", name: "Table", config: {}, updated_seq: 5 } as never]);
    applyEvents(
      [
        event(12, {
          type: "dbview.updated",
          entity_type: "dbview",
          entity_id: "v1",
          data: { changes: { config: { from: {}, to: { widths: { p1: 250 } } } } },
        }),
      ],
      true,
    );
    // The page's fetch, read before that change, answers after it.
    mergeRows("dbviews", [{ id: "v1", name: "Table", config: {}, updated_seq: 5 } as never]);
    expect(getState().collections.dbviews.v1).toMatchObject({ config: { widths: { p1: 250 } }, updated_seq: 12 });
  });
});

describe("clearStore", () => {
  it("empties the copy and everything known about it", () => {
    loadBootstrap(
      "acme",
      boot({ part: "open", rest: 1, tasks: [{ id: "t1", title: "a" }], projects: [{ id: "p1", key: "SVA" }] }),
    );
    markOpened("t1");
    markDrafts("tasks", ["t5"]);
    loadBootstrap("acme", boot({ tasks: [] }), { fresh: true });
    expect(getState().lostProjects).toEqual(["SVA"]);

    clearStore();
    expect(getState()).toMatchObject({
      slug: "",
      ready: false,
      seq: 0,
      me: null,
      user: null,
      workspace: null,
      opened: {},
      drafts: {},
      lostProjects: [],
      restLoaded: false,
      stream: "connecting",
    });
    expect(Object.values(getState().collections).every((table) => Object.keys(table).length === 0)).toBe(true);
  });
});

describe("onReplaced", () => {
  it("hears a copy thrown away, not one read again for the same workspace", () => {
    const heard = vi.fn();
    const off = onReplaced(heard);
    loadBootstrap("acme", boot());
    expect(heard).toHaveBeenCalledTimes(1);
    loadBootstrap("acme", boot({ seq: 20 }));
    expect(heard).toHaveBeenCalledTimes(1);
    loadBootstrap("acme", boot({ seq: 30 }), { fresh: true });
    expect(heard).toHaveBeenCalledTimes(2);
    loadBootstrap("other", boot());
    expect(heard).toHaveBeenCalledTimes(3);
    clearStore();
    expect(heard).toHaveBeenCalledTimes(4);
    off();
    clearStore();
    expect(heard).toHaveBeenCalledTimes(4);
  });
});
