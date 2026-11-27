// Comment drafts (data/comment-drafts.ts): kept by what they are for, for
// the member who wrote them in the workspace they wrote them in; another
// member, or the same member elsewhere, starts empty; signing out lets go
// of them all.

import { beforeEach, describe, expect, it } from "vitest";
import { clearCommentDrafts, commentDraft, dropDraft, editDraft } from "@/data/comment-drafts";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";

const as = (slug: string, userId: string) => {
  clearStore();
  loadBootstrap(slug, {
    seq: 1,
    me: { user_id: userId, role: "member", name: userId, kind: "person", handle: userId } as Member,
    user: { id: userId } as User,
    workspace: { id: slug, slug, name: slug } as Workspace,
  });
};

beforeEach(() => {
  clearCommentDrafts();
  as("acme", "ann");
});

describe("comment drafts", () => {
  it("keeps what is written for what it is for, and lets it go when sent", () => {
    editDraft("reply t1", (d) => ({ ...d, body: "Half" }));
    expect(commentDraft("reply t1").body).toBe("Half");
    expect(commentDraft("reply t2").body).toBe("");
    dropDraft("reply t1");
    expect(commentDraft("reply t1").body).toBe("");
  });

  it("is the writer's own: another member, or the same one in another workspace, starts empty", () => {
    editDraft("reply t1", (d) => ({ ...d, body: "Ann's half" }));
    as("acme", "bob");
    expect(commentDraft("reply t1").body).toBe("");
    as("other", "ann");
    expect(commentDraft("reply t1").body).toBe("");
    as("acme", "ann");
    expect(commentDraft("reply t1").body).toBe("Ann's half");
  });

  it("is let go of entirely when the drafts are cleared, as on signing out", () => {
    editDraft("reply t1", (d) => ({ ...d, body: "Half" }));
    clearCommentDrafts();
    expect(commentDraft("reply t1").body).toBe("");
  });
});
