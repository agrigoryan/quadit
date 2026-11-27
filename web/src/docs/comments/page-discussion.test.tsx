// @vitest-environment jsdom
// A page's own discussion, under its title (docs/comments/page-discussion.tsx):
// threads on the page as a whole and on words taken out, short until
// opened; "Add comment" opens a box for one, as Ctrl+M away from the text
// does; what was written in it stays when the box is put away; a reader who
// may not comment is offered no box.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Comment, Member, User, Workspace } from "@/types/core";
import { useCommentDrafts } from "@/docs/comments/drafts";
import { PageDiscussion } from "@/docs/comments/page-discussion";
import { pageUi, usePageUi } from "@/docs/page/state";
import { TooltipProvider } from "@/ui/tooltip";
import { WithQuery } from "@/test/query";

const me = { user_id: "u1", role: "owner", name: "Aram", kind: "person", handle: "aram" } as Member;

const comment = (id: string, body: string, at: number, more: Partial<Comment> = {}) =>
  ({
    id,
    doc_id: "d1",
    subject_type: "doc",
    subject_id: "d1",
    kind: "comment",
    author_id: "u1",
    body,
    created_at: at,
    ...more,
  }) as Comment;

function seed(member: Member) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [member],
    comments: [
      comment("page", "Keep it short.", 1),
      comment("answer", "Agreed.", 2, { parent_id: "page" }),
      comment("cut", "Why cut?", 3, { quote: "the old plan", detached_at: 4 }),
      comment("words", "On words", 5, { subject_type: "doc_block", subject_id: "b1", quote: "phases" }),
    ],
  });
}

beforeEach(() => {
  useCommentDrafts.setState({ drafts: {} });
  pageUi.reset();
  seed(me);
});

const show = () =>
  render(
    <WithQuery>
      <TooltipProvider>
        <PageDiscussion docId="d1" projectId={undefined} answersKeys />
      </TooltipProvider>
    </WithQuery>,
  );

describe("PageDiscussion", () => {
  it("shows the threads on the page and on words taken out, short, and none on the text", () => {
    show();
    const section = screen.getByRole("region", { name: "Comments on the page" });
    expect(within(section).getByText("Keep it short.")).toBeInTheDocument();
    expect(within(section).queryByText("Agreed.")).toBeInTheDocument();
    const cut = within(section).getByRole("article", { name: /the old plan/ });
    expect(within(cut).getByText("Why cut?")).toBeInTheDocument();
    expect(within(section).queryByText("On words")).toBeNull();
    expect(within(section).queryByRole("textbox", { name: "Reply…" })).toBeNull();
  });

  it("opens a thread in place with the cursor in its reply box, and Esc closes it", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getAllByRole("button", { name: "Reply…" })[0] as HTMLElement);
    const box = screen.getByRole("textbox", { name: "Reply…" });
    expect(box).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(usePageUi.getState().focusThread).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply…" })).toBeNull();
  });

  it("opens a box for a comment on the page from Add comment and from the keys, and keeps what was written", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    const box = screen.getByRole("textbox", { name: "Comment on the page…" });
    expect(box).toHaveFocus();
    await user.keyboard("Half a thought{Escape}");
    expect(screen.queryByRole("textbox", { name: "Comment on the page…" })).toBeNull();
    act(() => pageUi.commentOnPage());
    expect(screen.getByRole("textbox", { name: "Comment on the page…" })).toHaveValue("Half a thought");
    expect(screen.getByRole("textbox", { name: "Comment on the page…" })).toHaveFocus();
  });

  it("offers a reader who may not comment no box", () => {
    seed({ ...me, role: "member", scope: { read_only: true } });
    show();
    expect(screen.queryByRole("button", { name: "Add comment" })).toBeNull();
    expect(screen.getByText("Keep it short.")).toBeInTheDocument();
  });
});
