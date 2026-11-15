// @vitest-environment jsdom
// Looking up a task the store does not have (detail/data.ts useFindTask): a
// task that is not there is told apart from a server that did not answer,
// and a failed look is tried again when the live stream comes back.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFindTask } from "@/detail/data";
import { api, ApiError } from "@/lib/api";
import { clearStore, useStore } from "@/lib/store";

beforeEach(() => {
  clearStore();
  useStore.setState({ slug: "acme", stream: "live" });
});

afterEach(() => vi.restoreAllMocks());

describe("useFindTask", () => {
  it("says nothing went wrong when the server has no such task", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new ApiError(404, { message: "task SVA-9 not found" }));
    const { result } = renderHook(() => useFindTask("SVA-9", false));
    await waitFor(() => expect(result.current.looking).toBe(false));
    expect(result.current.error).toBe("");
  });

  it("reports a failure instead of reading it as not there", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new ApiError(500, { message: "database is down" }));
    const { result } = renderHook(() => useFindTask("SVA-9", false));
    await waitFor(() => expect(result.current.looking).toBe(false));
    expect(result.current.error).toBe("database is down");
  });

  it("looks again when the stream comes back", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useFindTask("SVA-9", false));
    await waitFor(() => expect(result.current.error).not.toBe(""));
    get.mockRejectedValue(new ApiError(404, { message: "not found" }));
    act(() => useStore.setState({ stream: "down" }));
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(result.current.error).toBe(""));
    expect(result.current.looking).toBe(false);
  });
});
