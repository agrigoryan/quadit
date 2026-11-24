// @vitest-environment jsdom
// The run outlook as pages read it (data/run-outlook.ts): by agent, one read
// for the agents asked, and nothing at all while the read fails, not even an
// earlier answer that would still promise a start.

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { liveKey } from "@/data/live";
import { queryClient } from "@/data/query";
import { useRunOutlook } from "@/data/run-outlook";
import { clearStore, loadBootstrap } from "@/data/store";
import { WithQuery } from "@/test/query";
import type { Member, User, Workspace } from "@/types/core";

const outlook = { agent: "@codex", outcome: "starts_now", machine: "Mac" };

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
  });
  vi.restoreAllMocks();
});

describe("useRunOutlook", () => {
  it("gives each agent's outlook by handle, asked once for all of them", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ outlooks: [outlook] });
    const { result } = renderHook(() => useRunOutlook("SVA-1", ["codex", "@codex"], "comment"), {
      wrapper: WithQuery,
    });
    await waitFor(() => expect(result.current.outlooks?.["@codex"]?.outcome).toBe("starts_now"));
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]?.[0]).toBe("/api/v1/w/acme/tasks/SVA-1/run-outlook?agents=%40codex&cause=comment");
  });

  it("gives nothing while the read fails, though an earlier answer said it starts now", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ outlooks: [outlook] });
    const { result } = renderHook(() => useRunOutlook("SVA-1", ["codex"], "comment"), { wrapper: WithQuery });
    await waitFor(() => expect(result.current.outlooks).toBeDefined());
    get.mockRejectedValue(new Error("the server is away"));
    await queryClient.invalidateQueries({ queryKey: liveKey("acme", null).slice(0, -1) });
    await waitFor(() => expect(result.current.error).not.toBe(""));
    expect(result.current.outlooks).toBeUndefined();
  });

  it("asks nothing without a task or an agent", () => {
    const get = vi.spyOn(api, "get");
    renderHook(() => useRunOutlook(undefined, ["codex"], "comment"), { wrapper: WithQuery });
    renderHook(() => useRunOutlook("SVA-1", [], "comment"), { wrapper: WithQuery });
    expect(get).not.toHaveBeenCalled();
  });
});
