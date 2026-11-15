// @vitest-environment jsdom
// Looking up a task the store does not have (detail/data.ts useFindTask,
// useEnsureTasks): a task that is not there is told apart from a server that
// did not answer, and a failed look is tried again when the live stream
// comes back.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEnsureTasks, useFindTask } from "@/detail/data";
import { api, ApiError } from "@/data/api";
import { getRowEvenIfGone } from "@/data/selectors";
import { clearStore, useStore } from "@/data/store";
import { WithQuery } from "@/test/query";

beforeEach(() => {
  clearStore();
  useStore.setState({ slug: "acme", stream: "live" });
});

afterEach(() => vi.restoreAllMocks());

describe("useFindTask", () => {
  it("says nothing went wrong when the server has no such task", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new ApiError(404, { message: "task SVA-9 not found" }));
    const { result } = renderHook(() => useFindTask("SVA-9", false), { wrapper: WithQuery });
    await waitFor(() => expect(result.current.looking).toBe(false));
    expect(result.current.error).toBe("");
  });

  it("reports a failure instead of reading it as not there", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new ApiError(500, { message: "database is down" }));
    const { result } = renderHook(() => useFindTask("SVA-9", false), { wrapper: WithQuery });
    await waitFor(() => expect(result.current.looking).toBe(false));
    expect(result.current.error).toBe("database is down");
  });

  it("looks again when the stream comes back", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useFindTask("SVA-9", false), { wrapper: WithQuery });
    await waitFor(() => expect(result.current.error).not.toBe(""));
    get.mockRejectedValue(new ApiError(404, { message: "not found" }));
    act(() => useStore.setState({ stream: "down" }));
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(result.current.error).toBe(""));
    expect(result.current.looking).toBe(false);
  });
});

describe("useEnsureTasks", () => {
  it("asks again for a task whose fetch failed when the stream comes back", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new ApiError(500, { message: "database is down" }));
    renderHook(() => useEnsureTasks(["t9"]), { wrapper: WithQuery });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    get.mockResolvedValue({ task: { id: "t9", key: "SVA-9", project_id: "p1", title: "closed" } });
    act(() => useStore.setState({ stream: "down" }));
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(getRowEvenIfGone("tasks", "t9")?.title).toBe("closed"));
  });

  it("does not ask again for a task the server says is not there", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new ApiError(404, { message: "not found" }));
    const { rerender } = renderHook(() => useEnsureTasks(["t9"]), { wrapper: WithQuery });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerender();
    await new Promise((r) => setTimeout(r, 10));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
