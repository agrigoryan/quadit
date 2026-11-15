// @vitest-environment jsdom
// Older agent sessions (insights/agents/session-data.ts useSessions): a failed
// fetch is reported, so a page does not show the store's recent ones as all
// there are, and it is tried again when the live stream comes back.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessions } from "@/insights/agents/session-data";
import { api, ApiError } from "@/lib/api";
import { clearStore, useStore } from "@/lib/store";

const all = () => true;

beforeEach(() => {
  clearStore();
  useStore.setState({ slug: "acme", stream: "live" });
});

afterEach(() => vi.restoreAllMocks());

describe("useSessions", () => {
  it("reports a failed fetch, and clears it once a fetch on reconnect works", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new ApiError(500, { message: "database is down" }));
    const { result } = renderHook(() => useSessions("limit=300", all));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("database is down");

    get.mockResolvedValue({ sessions: [] });
    act(() => useStore.setState({ stream: "down" }));
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(result.current.error).toBe(""));
  });
});
