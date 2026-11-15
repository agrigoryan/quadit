// @vitest-environment jsdom
// Fetching a database's properties (docs/db/use-table.ts ensureDatabase): a
// failure is said, rather than leaving the cells that read it blank as if
// that were all, and the fetch is tried again when the live stream comes back.
// A database that is not there (or not for this person) is not a failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDatabase } from "@/docs/db/use-table";
import { api, ApiError } from "@/lib/api";
import { clearStore, useStore } from "@/lib/store";
import { useToasts } from "@/lib/toast";

const page = (id: string) => ({ doc: { id }, properties: [], views: [] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  clearStore();
  useStore.setState({ slug: "acme", stream: "live" });
  useToasts.setState({ items: [] });
});

afterEach(() => vi.restoreAllMocks());

describe("ensureDatabase", () => {
  it("says a failed fetch and asks again on reconnect", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new ApiError(500, { message: "database is down" }));
    ensureDatabase("db-fail");
    await settle();
    expect(useToasts.getState().items.map((i) => i.kind)).toEqual(["error"]);

    get.mockResolvedValue(page("db-fail"));
    useStore.setState({ stream: "down" });
    useStore.setState({ stream: "live" });
    await settle();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("is quiet about a database that is not there", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new ApiError(404, { message: "not found" }));
    ensureDatabase("db-gone");
    await settle();
    expect(useToasts.getState().items).toEqual([]);
  });
});
