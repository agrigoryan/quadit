// What a page's comment drafts are kept under (docs/comments/drafts.ts):
// other words at the same place, or the same place with other words, are
// another draft's.

import { describe, expect, it } from "vitest";
import { draftFor } from "@/docs/comments/drafts";

describe("draftFor.thread", () => {
  it("tells words at the same place apart by what they read", () => {
    const red = { block: "b1", start: 4, end: 7, quote: "red" };
    expect(draftFor.thread("b1", red)).not.toBe(draftFor.thread("b1", { ...red, quote: "tan" }));
    expect(draftFor.thread("b1", red)).toBe(draftFor.thread("b1", { ...red }));
    expect(draftFor.thread("b1", red)).not.toBe(draftFor.thread("b1"));
  });
});
