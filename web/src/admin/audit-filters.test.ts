// How the audit log's day filters become the moments the server is asked for.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditQuery, noFilters } from "@/admin/audit-filters";

const HOUR = 3_600_000;
const zone = process.env.TZ;
beforeAll(() => void (process.env.TZ = "Europe/Berlin"));
afterAll(() => void (process.env.TZ = zone));

const query = (from: string, to: string) => new URLSearchParams(auditQuery({ ...noFilters, from, to }));

describe("auditQuery", () => {
  it("asks for what happened from the person's own midnight on the first day to the end of the last", () => {
    const q = query("2026-11-02", "2026-11-03");
    // Berlin is an hour ahead of UTC in November.
    expect(q.get("after")).toBe(String(Date.UTC(2026, 10, 1, 23) - 1));
    expect(q.get("before")).toBe(String(Date.UTC(2026, 10, 3, 23)));
  });

  it("ends a day at the person's next midnight, also on the day the clocks change and the day is 23 hours long", () => {
    const q = query("2026-03-29", "2026-03-29");
    expect(q.get("after")).toBe(String(Date.UTC(2026, 2, 28, 23) - 1));
    // Berlin is two hours ahead of UTC from 02:00 that day: its next midnight is 22:00 UTC, 23 hours on.
    expect(q.get("before")).toBe(String(Date.UTC(2026, 2, 28, 23) + 23 * HOUR));
  });

  it("leaves out a day that is not chosen", () => {
    const q = query("", "");
    expect(q.has("after")).toBe(false);
    expect(q.has("before")).toBe(false);
  });
});
