// @vitest-environment jsdom
// Restoring a page the workspace copy never had (docs/actions.ts restoreDoc):
// it is fetched whole after the restore, and a fetch that failed is said
// rather than dropped. A page the server then says is not there is no
// failure to report.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreDoc } from "@/docs/actions";
import { api, ApiError } from "@/lib/api";
import { getRowEvenIfGone } from "@/lib/selectors";
import { clearStore, loadBootstrap, useStore } from "@/lib/store";
import { useToasts } from "@/lib/toast";
import type { Member, User, Workspace } from "@/types/core";
import "@/test/query";

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Ann", kind: "person", handle: "ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
  });
  useStore.setState({ stream: "live" });
  useToasts.setState({ items: [] });
  vi.spyOn(api, "post").mockResolvedValue({ results: [{}] });
});

afterEach(() => vi.restoreAllMocks());

describe("restoreDoc", () => {
  it("fetches a page the copy never had into it", async () => {
    vi.spyOn(api, "get").mockResolvedValue({ doc: { id: "d9", title: "Back again", kind: "page" }, blocks: [] });
    restoreDoc("d9");
    await vi.waitFor(() => expect(getRowEvenIfGone("docs", "d9")?.title).toBe("Back again"));
    expect(useToasts.getState().items).toEqual([]);
  });

  it("says so when the restored page could not be fetched", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new ApiError(500, { message: "database is down" }));
    restoreDoc("d9");
    await vi.waitFor(() =>
      expect(useToasts.getState().items.map((i) => i.text)).toEqual([
        "The page is restored, but it could not be loaded: database is down",
      ]),
    );
  });

  it("is quiet when the server says the page is not there", async () => {
    const get = vi.spyOn(api, "get").mockRejectedValue(new ApiError(404, { message: "not found" }));
    restoreDoc("d9");
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(useToasts.getState().items.filter((i) => i.kind === "error")).toEqual([]);
  });
});
