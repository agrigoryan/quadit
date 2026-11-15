// A database's properties and views change through mutate() like any row:
// shown at once, and when refused, put back only where nothing newer came.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { getRow, getRowEvenIfGone } from "@/data/selectors";
import { applyEvents, clearStore, loadBootstrap, mergeRows } from "@/data/store";
import { setRowProps } from "@/docs/actions";
import { setViewConfig } from "@/docs/db/actions";
import type { FeedEvent, Member, User, Workspace } from "@/types/core";
import type { DBView } from "@/types/docs";

/** Every change sent is refused, once the test says so. */
function refusingServer() {
  const refusals: (() => void)[] = [];
  vi.spyOn(api, "post").mockImplementation(
    () => new Promise((_resolve, reject) => refusals.push(() => reject(new ApiError(400, { message: "no" })))),
  );
  return refusals;
}

const settle = () => vi.advanceTimersByTimeAsync(0);

const view: DBView = { id: "v1", database_id: "db1", name: "Table", type: "table", rank: "a" };

beforeEach(() => {
  vi.useFakeTimers();
  clearStore();
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    docs: [{ id: "r1", parent_id: "db1", kind: "row", title: "One", rank: "a", props: {} }],
  });
  mergeRows("dbviews", [view]);
  mergeRows("properties", [
    {
      id: "p1",
      database_id: "db1",
      name: "Stage",
      type: "select",
      rank: "a",
      config: { options: [{ name: "Open", color: "gray" }] },
    },
  ]);
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("database actions", () => {
  it("puts a refused view change back without undoing a rename that came from the feed meanwhile", async () => {
    const refusals = refusingServer();
    setViewConfig(view, { hidden: ["p1"] });
    expect(getRow("dbviews", "v1")?.config).toEqual({ hidden: ["p1"] });

    const renamed: FeedEvent = {
      seq: 11,
      at: 11,
      actor_id: "u2",
      change_id: "c11",
      type: "dbview.updated",
      entity_type: "dbview",
      entity_id: "v1",
      scope_type: "",
      scope_id: "",
      data: { changes: { name: { from: "Table", to: "Everything" } } },
    };
    applyEvents([renamed], true);
    await settle();
    refusals[0]?.();
    await settle();

    expect(getRowEvenIfGone("dbviews", "v1")).toMatchObject({ name: "Everything" });
    expect(getRowEvenIfGone("dbviews", "v1")?.config).toBeUndefined();
  });

  it("shows an option named by a row's value on its property at once, and takes it away when refused", async () => {
    const refusals = refusingServer();
    setRowProps("r1", { p1: "Shipped" });
    expect(getRow("properties", "p1")?.config?.options?.map((o) => o.name)).toEqual(["Open", "Shipped"]);

    await settle();
    refusals[0]?.();
    await settle();
    expect(getRow("properties", "p1")?.config?.options?.map((o) => o.name)).toEqual(["Open"]);
  });
});
