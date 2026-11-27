// @vitest-environment jsdom
// Reading a page (docs/store.ts): what it brings is filed in the workspace
// copy, its comments and the files on them among it, so its threads show
// their files as soon as it opens.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { getRow } from "@/data/selectors";
import { clearStore, loadBootstrap } from "@/data/store";
import { loadPage } from "@/docs/store";
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
});

afterEach(() => vi.restoreAllMocks());

describe("loadPage", () => {
  it("files the page's comments and the files on them", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      doc: { id: "d1", title: "Plan", kind: "page" },
      blocks: [],
      comments: [{ id: "c1", doc_id: "d1", subject_type: "doc", subject_id: "d1", body: "see", created_at: 1 }],
      attachments: [
        {
          id: "a1",
          file_id: "f1",
          subject_type: "comment",
          subject_id: "c1",
          rank: "1",
          file: { id: "f1", name: "sketch.png", content_type: "image/png", url: "/f/f1/sketch.png" },
        },
      ],
    });
    await loadPage("d1");
    expect(getRow("comments", "c1")?.body).toBe("see");
    expect(getRow("attachments", "a1")?.file?.name).toBe("sketch.png");
  });
});
