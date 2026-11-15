// @vitest-environment jsdom
// The rules every read through the query client runs on (data/query.ts): what
// is tried again, when a workspace's reads go out again, and what is
// dropped when the workspace copy is replaced or the person signs out.

import { useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "@/data/api";
import { inWorkspace, queryClient, readError, retryUnreachable } from "@/data/query";
import { type BootstrapData, clearStore, loadBootstrap, useStore } from "@/data/store";
import { WithQuery } from "@/test/query";

const copy = (seq: number) => ({ seq, me: {}, user: {}, workspace: {} }) as unknown as BootstrapData;

function read(key: readonly unknown[], fetch: () => Promise<string>) {
  return renderHook(() => useQuery({ queryKey: key, queryFn: fetch }), { wrapper: WithQuery });
}

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", copy(1));
  useStore.setState({ stream: "live" });
});

describe("trying again", () => {
  it("tries again only what the server did not answer, a few times", () => {
    expect(retryUnreachable(0, new NetworkError())).toBe(true);
    expect(retryUnreachable(3, new NetworkError())).toBe(false);
    expect(retryUnreachable(0, new ApiError(404, {}))).toBe(false);
    expect(retryUnreachable(0, new ApiError(500, { message: "database is down" }))).toBe(false);
  });

  it("shows nothing for a 401: the person is on the way to sign in", () => {
    expect(readError(new ApiError(401, { message: "signed out" }))).toBe("");
    expect(readError(new ApiError(403, { message: "not yours" }))).toBe("not yours");
    expect(readError(null)).toBe("");
  });
});

describe("the live stream", () => {
  it("asks a workspace's reads again when the stream is back", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new NetworkError()).mockResolvedValue("tokens");
    const { result } = read([...inWorkspace("acme"), "tokens"], fetch);
    await waitFor(() => expect(result.current.isError).toBe(true));
    act(() => useStore.setState({ stream: "down" }));
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(result.current.data).toBe("tokens"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("holds a workspace's read while the stream is down and sends it when it is back", async () => {
    act(() => useStore.setState({ stream: "down" }));
    const fetch = vi.fn().mockResolvedValue("tokens");
    const { result } = read([...inWorkspace("acme"), "tokens"], fetch);
    await waitFor(() => expect(result.current.fetchStatus).toBe("paused"));
    expect(fetch).not.toHaveBeenCalled();
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(result.current.data).toBe("tokens"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not ask again when the stream first opens", async () => {
    act(() => useStore.setState({ stream: "connecting" }));
    const fetch = vi.fn().mockResolvedValue("tokens");
    const { result } = read([...inWorkspace("acme"), "tokens"], fetch);
    await waitFor(() => expect(result.current.data).toBe("tokens"));
    act(() => useStore.setState({ stream: "live" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a read outside a workspace even while the stream is down", async () => {
    act(() => useStore.setState({ stream: "down" }));
    const fetch = vi.fn().mockResolvedValue("me");
    const { result } = read(["me", "account"], fetch);
    await waitFor(() => expect(result.current.data).toBe("me"));
  });
});

describe("a replaced copy", () => {
  it("drops what was read for a workspace when another one opens", async () => {
    await queryClient.fetchQuery({ queryKey: [...inWorkspace("acme"), "tokens"], queryFn: () => "acme tokens" });
    loadBootstrap("games", copy(1));
    expect(queryClient.getQueryData([...inWorkspace("acme"), "tokens"])).toBeUndefined();
  });

  it("asks again a read on screen when the person's access changed", async () => {
    const fetch = vi.fn().mockResolvedValueOnce("before").mockResolvedValue("after");
    const { result } = read([...inWorkspace("acme"), "tokens"], fetch);
    await waitFor(() => expect(result.current.data).toBe("before"));
    act(() => loadBootstrap("acme", copy(2), { fresh: true }));
    await waitFor(() => expect(result.current.data).toBe("after"));
  });

  it("drops every read at sign-out, the account's too", async () => {
    await queryClient.fetchQuery({ queryKey: [...inWorkspace("acme"), "tokens"], queryFn: () => "tokens" });
    await queryClient.fetchQuery({ queryKey: ["me", "account"], queryFn: () => "me" });
    clearStore();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
