// @vitest-environment jsdom
// Fetching a database's properties (docs/db/use-table.ts useEnsureDatabases):
// a failure is said, rather than leaving the cells that read it blank as if
// that were all, and the fetch is tried again when the live stream comes back.
// A database that is not there (or not for this person) is not a failure.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEnsureDatabases } from "@/docs/db/use-table";
import { useDocsStore } from "@/docs/store";
import { api, ApiError } from "@/data/api";
import { clearStore, useStore } from "@/data/store";
import { useToasts } from "@/lib/toast";
import { WithQuery } from "@/test/query";

const page = (id: string) => ({
  doc: { id },
  properties: [{ id: "p1", database_id: id, name: "Status", type: "select", rank: "a" }],
  views: [],
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  clearStore();
  useStore.setState({ slug: "acme", stream: "live" });
  useToasts.setState({ items: [] });
});

afterEach(() => vi.restoreAllMocks());

describe("useEnsureDatabases", () => {
  it("says a failed fetch and asks again on reconnect", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new ApiError(500, { message: "database is down" }));
    renderHook(() => useEnsureDatabases(["db-fail"]), { wrapper: WithQuery });
    await waitFor(() => expect(useToasts.getState().items.map((i) => i.kind)).toEqual(["error"]));

    get.mockResolvedValue(page("db-fail"));
    act(() => useStore.setState({ stream: "down" }));
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(useDocsStore.getState().props.p1?.name).toBe("Status"));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("is quiet about a database that is not there", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new ApiError(404, { message: "not found" }));
    renderHook(() => useEnsureDatabases(["db-gone"]), { wrapper: WithQuery });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await settle();
    expect(useToasts.getState().items).toEqual([]);
  });

  it("asks once for a database named twice", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue(page("db-1"));
    renderHook(() => useEnsureDatabases(["db-1", "db-1", undefined]), { wrapper: WithQuery });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await settle();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
