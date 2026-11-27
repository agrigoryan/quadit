// @vitest-environment jsdom
// A comment on a page sent with files (docs/actions.ts addComment): the
// change carries them, and the comment shows them before the server answers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addComment } from "@/docs/actions";
import { api } from "@/data/api";
import { getRows } from "@/data/selectors";
import { clearStore, loadBootstrap, useStore } from "@/data/store";
import type { FileRow, Member, User, Workspace } from "@/types/core";

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Ann", kind: "person", handle: "ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
  });
  useStore.setState({ stream: "live" });
});

afterEach(() => vi.restoreAllMocks());

const sketch = { id: "f1", name: "sketch.png", content_type: "image/png", url: "/f/f1/sketch.png" } as FileRow;

describe("addComment", () => {
  it("sends the files with a reply and shows them on it at once", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ results: [{}] });
    const answered = addComment({ docId: "d1", parentId: "c0", body: "Like this", files: [sketch] });

    const comment = getRows("comments").find((c) => c.body === "Like this");
    const shown = getRows("attachments");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ subject_type: "comment", subject_id: comment?.id, file: { name: "sketch.png" } });
    expect(shown[0]?.task_id).toBeUndefined();

    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      changes: [
        {
          type: "comment.create",
          args: { doc: "d1", parent: "c0", body: "Like this", attachments: [{ id: shown[0]?.id, file: "f1" }] },
        },
      ],
    });
    await answered;
  });

  it("sends no files when none are given", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ results: [{}] });
    await addComment({ docId: "d1", body: "Plain" });
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    const sent = post.mock.calls[0]?.[1] as { changes: { args: object }[] } | undefined;
    expect(sent?.changes[0]?.args).not.toHaveProperty("attachments");
    expect(getRows("attachments")).toHaveLength(0);
  });
});
