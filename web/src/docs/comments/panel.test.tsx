// @vitest-environment jsdom
// The comments beside a page (docs/comments/panel.tsx): each thread on a
// block quotes the block's text as the editor has it, says when the block is
// gone, and threads follow the order of their blocks; Esc and the ask for
// the page's own box (Ctrl+M away from the text) reach it.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Comment, Member, User, Workspace } from "@/types/core";
import { CommentsPanel } from "@/docs/comments/panel";
import type { EditorHandle } from "@/docs/editor/editor";
import { pageUi, usePageUi } from "@/docs/page/state";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "owner", name: "Me", kind: "person", handle: "me" } as Member;

const onBlock = (id: string, block: string, body: string, at: number) =>
  ({
    id,
    doc_id: "d1",
    subject_type: "doc_block",
    subject_id: block,
    kind: "comment",
    author_id: "u1",
    body,
    created_at: at,
  }) as Comment;

/** An editor that shows two blocks, b2 above b1. */
const editor: { current: EditorHandle } = {
  current: {
    scrollToBlock: () => {},
    blockText: (id) => ({ b1: "Ship by Friday", b2: "Goals" })[id],
    order: () => ["b2", "b1"],
  },
};

beforeEach(() => {
  pageUi.closeComments();
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    comments: [
      onBlock("c1", "b1", "Too soon?", 1),
      onBlock("c2", "b2", "Which goals?", 2),
      onBlock("c3", "gone", "About a removed line", 3),
    ],
  });
});

const panel = () =>
  render(
    <TooltipProvider>
      <CommentsPanel docId="d1" projectId={undefined} editor={editor} />
    </TooltipProvider>,
  );

describe("CommentsPanel", () => {
  it("quotes each thread's block, says when it is gone, and follows the blocks' order", async () => {
    panel();
    expect(await screen.findByText("Ship by Friday")).toBeInTheDocument();
    expect(screen.getByText("Goals")).toBeInTheDocument();
    expect(screen.getByText("The block this was on is gone")).toBeInTheDocument();
    const bodies = screen.getAllByText(/Too soon\?|Which goals\?|About a removed line/).map((el) => el.textContent);
    expect(bodies).toEqual(["Which goals?", "Too soon?", "About a removed line"]);
  });

  it("offers to show a thread's block in the page only while the block is there", async () => {
    panel();
    const onGone = (await screen.findByText("About a removed line")).closest("article") as HTMLElement;
    const onThere = screen.getByText("Too soon?").closest("article") as HTMLElement;
    expect(within(onThere).getByRole("button", { name: "Show in the page" })).toBeInTheDocument();
    expect(within(onGone).queryByRole("button", { name: "Show in the page" })).toBeNull();
  });

  it("Esc in a comment box leaves it with what was typed; away from one, it closes the column", async () => {
    const user = userEvent.setup();
    act(() => pageUi.commentOnPage());
    panel();
    const box = screen.getByRole("textbox", { name: "Comment on the page…" });
    await user.click(box);
    await user.keyboard("Not yet{Escape}");
    expect(box).not.toHaveFocus();
    expect(box).toHaveValue("Not yet");
    expect(usePageUi.getState().commentsOpen).toBe(true);
    await user.keyboard("{Escape}");
    expect(usePageUi.getState().commentsOpen).toBe(false);
  });

  it("puts the cursor in the page's own box when asked, and on each ask", async () => {
    const user = userEvent.setup();
    panel();
    const box = screen.getByRole("textbox", { name: "Comment on the page…" });
    expect(box).not.toHaveFocus();
    act(() => pageUi.commentOnPage());
    expect(box).toHaveFocus();
    await user.click(screen.getAllByRole("button", { name: /Show in the page|Resolve/ })[0] as HTMLElement);
    act(() => pageUi.commentOnPage());
    expect(box).toHaveFocus();
  });
});
