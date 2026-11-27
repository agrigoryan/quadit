// @vitest-environment jsdom
// Signing out (auth/session.ts) lets go of what the person was writing in
// comment boxes: the next person signed in on this browser starts empty.

import { beforeEach, describe, expect, it } from "vitest";
import { signOut } from "@/auth/session";
import { commentDraft, editDraft } from "@/data/comment-drafts";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import { fakeServer } from "@/test/fake-server";

const signIn = () => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Ann", kind: "person", handle: "ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
  });
};

beforeEach(signIn);

describe("signOut", () => {
  it("lets go of the comment drafts", async () => {
    const server = fakeServer();
    server.post("/api/v1/auth/logout", {});
    editDraft("reply t1", (d) => ({ ...d, body: "Not for the next person" }));
    await signOut();
    // Even signed in again as the same member, here: they are gone, not only out of sight.
    signIn();
    expect(commentDraft("reply t1").body).toBe("");
  });
});
