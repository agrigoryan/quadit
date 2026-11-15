// How one feed event changes the browser's copy (lib/apply.ts).

import { describe, expect, it } from "vitest";
import { applyEvent, CopyOnWrite } from "@/lib/apply";
import { type AnyRow, type Collections, emptyCollections } from "@/lib/collections";
import type { FeedEvent } from "@/types/core";

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

/** Collections holding the given rows, keyed by id. */
function withRows(rows: Partial<Record<keyof Collections, AnyRow[]>>): Collections {
  const c = emptyCollections() as unknown as Record<string, Record<string, AnyRow>>;
  for (const [name, list] of Object.entries(rows)) {
    for (const row of list) (c[name] as Record<string, AnyRow>)[String(row.id ?? row.user_id)] = row;
  }
  return c as unknown as Collections;
}

function apply(c: Collections, ...events: FeedEvent[]): Collections {
  const d = new CopyOnWrite(c);
  for (const ev of events) applyEvent(d, ev);
  return d.done();
}

describe("applyEvent", () => {
  it("puts the row an event carries, replacing the old copy whole", () => {
    const c = withRows({ tasks: [{ id: "t1", title: "old", description: "stale" }] });
    const next = apply(c, event(5, { data: { row: { id: "t1", title: "new" } } }));
    expect(next.tasks.t1).toEqual({ id: "t1", title: "new" });
  });

  it("puts a member under its user id", () => {
    const next = apply(
      emptyCollections(),
      event(5, { entity_type: "member", entity_id: "m9", data: { row: { user_id: "u7", role: "admin" } } }),
    );
    expect(Object.keys(next.members)).toEqual(["u7"]);
  });

  it("patches the changed fields, and a null clears a field", () => {
    const c = withRows({ tasks: [{ id: "t1", title: "a", priority: 1, due: "2026-01-01", updated_seq: 3 }] });
    const next = apply(
      c,
      event(7, { data: { changes: { priority: { from: 1, to: 3 }, due: { from: "2026-01-01", to: null } } } }),
    );
    expect(next.tasks.t1).toEqual({ id: "t1", title: "a", priority: 3, updated_at: 1007, updated_seq: 7 });
    expect(next.tasks.t1).not.toHaveProperty("due");
  });

  it("does not create a row from a change to a row it does not have", () => {
    const next = apply(emptyCollections(), event(7, { data: { changes: { title: { from: "a", to: "b" } } } }));
    expect(next.tasks).toEqual({});
  });

  it("drops a row that is gone", () => {
    const c = withRows({ tasks: [{ id: "t1" }, { id: "t2" }] });
    const next = apply(c, event(8, { data: { gone: true } }));
    expect(Object.keys(next.tasks)).toEqual(["t2"]);
  });

  it("patches every row a batch names in ids, and only those", () => {
    const c = withRows({
      tasks: [
        { id: "t1", status_id: "a" },
        { id: "t2", status_id: "a" },
        { id: "t3", status_id: "a" },
      ],
    });
    const next = apply(
      c,
      event(9, { entity_id: "", data: { ids: ["t1", "t3"], changes: { status_id: { from: "a", to: "b" } } } }),
    );
    expect([next.tasks.t1?.status_id, next.tasks.t2?.status_id, next.tasks.t3?.status_id]).toEqual(["b", "a", "b"]);
  });

  it("keys a watcher by user and subject, from the event's audience when the data names no user", () => {
    const c = emptyCollections();
    c.watchers = {
      "u2:t1": { user_id: "u2", subject_id: "t1" } as never,
      "u3:t1": { user_id: "u3", subject_id: "t1" } as never,
    };
    const next = apply(c, event(4, { entity_type: "watcher", audience_id: "u2", data: { gone: true } }));
    expect(Object.keys(next.watchers)).toEqual(["u3:t1"]);
    const again = apply(next, event(5, { entity_type: "watcher", data: { user_id: "u3", gone: true } }));
    expect(again.watchers).toEqual({});
  });

  it("changes nothing more when the same event is applied twice", () => {
    const c = withRows({ tasks: [{ id: "t1", title: "a", updated_seq: 1 }, { id: "t2" }] });
    const events = [
      event(2, { data: { changes: { title: { from: "a", to: "b" } } } }),
      event(3, { entity_id: "t2", data: { gone: true } }),
      event(4, { entity_id: "t5", data: { row: { id: "t5", title: "new" } } }),
    ];
    const once = apply(c, ...events);
    expect(apply(once, ...events)).toEqual(once);
  });

  it("touches only the rows the `only` filter lets through", () => {
    const c = withRows({
      tasks: [
        { id: "t1", status_id: "a" },
        { id: "t2", status_id: "a" },
      ],
    });
    const d = new CopyOnWrite(c);
    const batch = event(9, { data: { ids: ["t1", "t2"], changes: { status_id: { from: "a", to: "b" } } } });
    applyEvent(d, batch, (collection, key) => collection === "tasks" && key === "t2");
    applyEvent(d, event(10, { entity_id: "t1", data: { gone: true } }), () => false);
    const next = d.done();
    expect(next.tasks.t1?.status_id).toBe("a");
    expect(next.tasks.t2?.status_id).toBe("b");
  });

  it("leaves the collections it did not touch as the same objects", () => {
    const c = withRows({ tasks: [{ id: "t1" }], comments: [{ id: "k1" }] });
    const next = apply(c, event(3, { data: { gone: true } }));
    expect(next.comments).toBe(c.comments);
    expect(next.tasks).not.toBe(c.tasks);
    expect(c.tasks.t1).toBeDefined();
  });
});
