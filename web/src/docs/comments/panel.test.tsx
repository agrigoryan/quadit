// @vitest-environment jsdom
// The comments beside a page (docs/comments/panel.tsx): each thread on a
// block quotes the block's text as the editor has it, says when the block is
// gone, and threads follow the order of their blocks.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Comment, Member, User, Workspace } from "@/lib/types";
import { CommentsPanel } from "@/docs/comments/panel";
import type { EditorHandle } from "@/docs/editor/editor";
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

describe("CommentsPanel", () => {
  it("quotes each thread's block, says when it is gone, and follows the blocks' order", async () => {
    render(
      <TooltipProvider>
        <CommentsPanel docId="d1" projectId={undefined} editor={editor} />
      </TooltipProvider>,
    );
    expect(await screen.findByText("Ship by Friday")).toBeInTheDocument();
    expect(screen.getByText("Goals")).toBeInTheDocument();
    expect(screen.getByText("The block this was on is gone")).toBeInTheDocument();
    const bodies = screen.getAllByText(/Too soon\?|Which goals\?|About a removed line/).map((el) => el.textContent);
    expect(bodies).toEqual(["Which goals?", "Too soon?", "About a removed line"]);
  });
});
