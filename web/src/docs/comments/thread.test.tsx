// @vitest-environment jsdom
// A comment thread on a page (docs/comments/thread.tsx): one who may change
// the page answers, resolves and deletes their own; a read-only member, whose
// every change the server refuses, is offered none of it. Each comment shows
// its files, a picture as a picture. It is named after who started it and
// what it is on; compact, it shows its replies in short; asked, its reply
// box takes the cursor; Esc in the box leaves the cursor on the thread.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Attachment, Comment, Member, User, Workspace } from "@/types/core";
import { clearCommentDrafts, editDraft } from "@/data/comment-drafts";
import { draftFor } from "@/docs/comments/drafts";
import { Thread } from "@/docs/comments/thread";
import { TooltipProvider } from "@/ui/tooltip";

const comment = {
  id: "c1",
  doc_id: "d1",
  subject_type: "doc",
  subject_id: "d1",
  kind: "comment",
  author_id: "u1",
  body: "Looks good",
  created_at: 1,
} as Comment;

const reply = { ...comment, id: "c2", parent_id: "c1", body: "Here is the log", created_at: 2 } as Comment;

const attached = (id: string, on: string, name: string, type: string) =>
  ({
    id,
    file_id: `f-${id}`,
    subject_type: "comment",
    subject_id: on,
    rank: "1",
    created_by: "u1",
    created_at: 1,
    file: { id: `f-${id}`, name, content_type: type, size: 10, url: `/f/${name}` },
  }) as Attachment;

function seed(me: Member, attachments: Attachment[] = []) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    attachments,
  });
}

const show = (replies: Comment[] = []) =>
  render(
    <TooltipProvider>
      <Thread thread={{ root: comment, replies }} docId="d1" projectId={undefined} active={false} />
    </TooltipProvider>,
  );

const member = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;

describe("Thread", () => {
  beforeEach(() => {
    clearCommentDrafts();
    seed(member);
  });

  it("offers a member who may write a reply, resolve and deleting their own comment", () => {
    show();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Reply…")).toBeTruthy();
  });

  it("is named after who started it and the words it is on", () => {
    render(
      <TooltipProvider>
        <Thread thread={{ root: comment, replies: [] }} docId="d1" projectId={undefined} subject="the plan" active />
      </TooltipProvider>,
    );
    expect(screen.getByRole("article", { name: "Comment by Me on “the plan”" })).toBeTruthy();
  });

  it("compact, shows its one reply, or how many there are, and a reply box that opens it", async () => {
    const reply = (id: string, body: string) => ({ ...comment, id, body, parent_id: "c1" });
    const onOpen = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <Thread
          thread={{ root: comment, replies: [reply("r1", "Agreed")] }}
          docId="d1"
          projectId={undefined}
          active={false}
          compact
          onOpen={onOpen}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText("Agreed")).toBeTruthy();
    rerender(
      <TooltipProvider>
        <Thread
          thread={{ root: comment, replies: [reply("r1", "Agreed"), reply("r2", "Me too")] }}
          docId="d1"
          projectId={undefined}
          active={false}
          compact
          onOpen={onOpen}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByText("Me too")).toBeNull();
    expect(screen.getByText("2 replies")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reply…" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("puts the cursor in its reply box when asked, and on the thread when Esc leaves the box", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TooltipProvider>
        <Thread thread={{ root: comment, replies: [] }} docId="d1" projectId={undefined} active askReply={false} />
      </TooltipProvider>,
    );
    const box = screen.getByRole("textbox", { name: "Reply…" });
    expect(box).not.toHaveFocus();
    rerender(
      <TooltipProvider>
        <Thread thread={{ root: comment, replies: [] }} docId="d1" projectId={undefined} active askReply />
      </TooltipProvider>,
    );
    await vi.waitFor(() => expect(box).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.getByRole("article")).toHaveFocus();
  });

  it("shows the reply begun and not sent in a compact thread's box", () => {
    editDraft(draftFor.reply("c1"), () => ({ body: "Half an answer", files: [] }));
    render(
      <TooltipProvider>
        <Thread thread={{ root: comment, replies: [] }} docId="d1" projectId={undefined} active={false} compact />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Half an answer" })).toBeTruthy();
  });

  it("gives a read-only member a button to open a compact thread, and the cursor on the thread when it is asked for", async () => {
    seed({ ...member, scope: { read_only: true } });
    const { rerender } = render(
      <TooltipProvider>
        <Thread thread={{ root: comment, replies: [] }} docId="d1" projectId={undefined} active={false} compact />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Show the whole thread" })).toBeTruthy();
    rerender(
      <TooltipProvider>
        <Thread thread={{ root: comment, replies: [] }} docId="d1" projectId={undefined} active askReply />
      </TooltipProvider>,
    );
    await vi.waitFor(() => expect(screen.getByRole("article")).toHaveFocus());
  });

  it("offers a read-only member none of it", () => {
    seed({ ...member, scope: { read_only: true } });
    show();
    expect(screen.getByText("Looks good")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete comment" })).toBeNull();
    expect(screen.queryByPlaceholderText("Reply…")).toBeNull();
  });

  it("shows the files of a comment and of a reply, a picture as a picture", () => {
    seed(member, [
      attached("a1", "c1", "sketch.png", "image/png"),
      attached("a2", "c2", "build.log", "text/plain"),
      attached("a3", "elsewhere", "other.png", "image/png"),
    ]);
    show([reply]);
    const picture = screen.getByRole("img", { name: "sketch.png" });
    expect(picture.getAttribute("src")).toBe("/f/sketch.png");
    expect(screen.getByRole("button", { name: /sketch\.png/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /build\.log/ })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "other.png" })).toBeNull();
  });
});
