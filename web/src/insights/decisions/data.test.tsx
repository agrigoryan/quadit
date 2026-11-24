// @vitest-environment jsdom
// The decision log's groups (insights/decisions/data.ts): what waits on me
// (asked of me, or sent back to me as its asker), then what waits on others
// (open for someone else, or sent back to whoever asked it), then the
// settled (picked, or no longer needed); newest first in each. The state
// filter picks one group, and counts each.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import { countBy, matches, noFilters, useEntries } from "@/insights/decisions/data";
import type { Decision, Member, User, Workspace } from "@/types/core";

const decision = (id: string, at: number, fields: Partial<Decision>): Decision =>
  ({
    id,
    task_id: "t1",
    kind: "choice",
    question: id,
    rank: id,
    created_by: "u2",
    created_at: at,
    ...fields,
  }) as Decision;

function entries() {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", kind: "person" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    tasks: [{ id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Jump" }],
    decisions: [
      decision("picked", 9, { state: "picked", asked_id: "u1", decided_at: 9 }),
      decision("askedOfMe", 2, { state: "open", asked_id: "u1" }),
      decision("sentBackByMe", 8, { state: "sent_back", asked_id: "u1", decided_by: "u1", decided_at: 8 }),
      decision("closed", 3, { state: "not_needed", asked_id: "u1", decided_by: "u1", decided_at: 3 }),
      decision("sentBackToMe", 5, { state: "sent_back", created_by: "u1", asked_id: "u2", decided_at: 5 }),
      decision("askedOfOther", 7, { state: "open", created_by: "u1", asked_id: "u2" }),
    ],
  });
  return renderHook(() => useEntries()).result.current;
}

describe("the decision log's groups", () => {
  it("puts what waits on me first, then what waits on others, then the settled, newest first in each", () => {
    expect(entries().map((e) => `${e.standing} ${e.decision.id}`)).toEqual([
      "yours sentBackToMe",
      "yours askedOfMe",
      "others sentBackByMe",
      "others askedOfOther",
      "settled picked",
      "settled closed",
    ]);
  });

  it("filters to one group, and counts each", () => {
    const all = entries();
    expect(all.filter((e) => matches(e, { ...noFilters, state: "others" })).map((e) => e.decision.id)).toEqual([
      "sentBackByMe",
      "askedOfOther",
    ]);
    expect(countBy(all, noFilters, "state")).toEqual({ all: 6, yours: 2, others: 2, settled: 2 });
  });

  it("counts and filters by who answered only questions answered, not one closed as no longer needed", () => {
    const all = entries();
    // u1 sent one back and closed another: only the first was answered by them.
    expect(countBy(all, noFilters, "by").u1).toBe(1);
    expect(all.filter((e) => matches(e, { ...noFilters, by: "u1" })).map((e) => e.decision.id)).toEqual([
      "sentBackByMe",
    ]);
  });
});
