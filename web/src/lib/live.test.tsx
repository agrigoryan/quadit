// @vitest-environment jsdom
// Reads kept fresh by the feed (lib/live.ts useLive): read once for every
// page that shows them, and asked again when a matching event arrives.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLive } from "@/lib/live";
import { applyEvents, clearStore, useStore } from "@/lib/store";
import type { FeedEvent } from "@/lib/types";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";
import { WithQuery } from "@/test/query";

const AGENTS = "/api/v1/w/acme/agents";
let server: FakeServer;
let seq = 1;

const event = (entity: string) =>
  ({
    seq: ++seq,
    type: `${entity}.updated`,
    entity_type: entity,
    entity_id: "x",
    scope_type: "",
    scope_id: "",
  }) as FeedEvent;

beforeEach(() => {
  clearStore();
  useStore.setState({ slug: "acme", stream: "live", seq: 1 });
  seq = 1;
  server = fakeServer();
});

afterEach(() => vi.unstubAllGlobals());

describe("useLive", () => {
  it("reads a path once for two readers, and again when a matching event arrives", async () => {
    server.get(AGENTS, { n: 1 });
    const { result } = renderHook(
      () => ({
        page: useLive<{ n: number }>("/agents", { throttleMs: 0 }),
        shell: useLive<{ n: number }>("/agents", { throttleMs: 0, only: ["member"] }),
      }),
      { wrapper: WithQuery },
    );
    await waitFor(() => expect(result.current.page.data?.n).toBe(1));
    expect(result.current.shell.data?.n).toBe(1);
    expect(server.count(AGENTS)).toBe(1);

    server.get(AGENTS, { n: 2 });
    act(() => applyEvents([event("task")], true));
    await waitFor(() => expect(result.current.shell.data?.n).toBe(2));
  });

  it("does not ask again for events it does not follow", async () => {
    server.get(AGENTS, { n: 1 });
    const { result } = renderHook(() => useLive<{ n: number }>("/agents", { throttleMs: 0, only: ["member"] }), {
      wrapper: WithQuery,
    });
    await waitFor(() => expect(result.current.data?.n).toBe(1));
    act(() => applyEvents([event("task")], true));
    await new Promise((r) => setTimeout(r, 10));
    expect(server.count(AGENTS)).toBe(1);
  });

  it("says why a read failed and keeps nothing it did not get", async () => {
    server.get(AGENTS, refuse(500, "database is down"));
    const { result } = renderHook(() => useLive<{ n: number }>("/agents"), { wrapper: WithQuery });
    await waitFor(() => expect(result.current.error).toBe("database is down"));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("reads nothing for no path", () => {
    const { result } = renderHook(() => useLive("/agents".slice(0, 0) || null), { wrapper: WithQuery });
    expect(result.current.loading).toBe(false);
    expect(server.requests).toEqual([]);
  });
});
