// @vitest-environment jsdom
// The comments pane (docs/comments/panel.tsx): every thread of the page,
// those last written in first, each quoting what it is on as the editor has
// it (a block gone, words taken out); the open ones or the resolved, of
// anyone or of one person; a click on one opens it in the page; Esc in a
// reply box leaves the box for the thread, and away from one closes the pane.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Comment, Member, User, Workspace } from "@/types/core";
import { useCommentDrafts } from "@/docs/comments/drafts";
import { CommentsPanel } from "@/docs/comments/panel";
import type { EditorHandle } from "@/docs/editor/editor";
import { pageUi, usePageUi } from "@/docs/page/state";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "owner", name: "Me", kind: "person", handle: "me" } as Member;
const ana = { user_id: "u2", role: "member", name: "Ana Lee", kind: "person", handle: "ana" } as Member;

const onBlock = (id: string, block: string, body: string, at: number, more: Partial<Comment> = {}) =>
  ({
    id,
    doc_id: "d1",
    subject_type: "doc_block",
    subject_id: block,
    kind: "comment",
    author_id: "u1",
    body,
    created_at: at,
    ...more,
  }) as Comment;

/** An editor that shows two blocks, b2 above b1. */
const editor: EditorHandle = {
  scrollToBlock: vi.fn(),
  scrollToThread: vi.fn(),
  blockText: (id) => ({ b1: "Ship by Friday, with the docs", b2: "Goals" })[id],
  threadText: (id) => ({ c4: "with the docs" })[id],
  selectedWords: () => undefined,
  onChange: () => () => {},
  order: () => ["b2", "b1"],
  caretBlock: () => null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useCommentDrafts.setState({ drafts: {} });
  pageUi.reset();
  pageUi.openComments();
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me, ana],
    comments: [
      onBlock("c1", "b1", "Too soon?", 1),
      onBlock("c2", "b2", "Which goals?", 2),
      onBlock("c3", "gone", "About a removed line", 3),
      onBlock("c4", "b1", "Which docs?", 4, { quote: "the docs" }),
      onBlock("c5", "d1", "Why cut?", 5, { subject_type: "doc", quote: "the old plan", detached_at: 6 }),
      onBlock("r1", "b1", "Monday then.", 9, { parent_id: "c1", author_id: "u2" }),
      onBlock("c6", "b2", "Done here.", 7, { resolved_at: 8 }),
    ],
  });
});

const pane = () =>
  render(
    <TooltipProvider>
      <CommentsPanel docId="d1" projectId={undefined} editor={editor} />
    </TooltipProvider>,
  );

const firsts = () => screen.getAllByRole("article").map((a) => a.querySelector(".md")?.textContent ?? a.textContent);

describe("the comments pane", () => {
  it("lists the open threads, those last written in first, each with what it is on", async () => {
    pane();
    expect(await screen.findByText("Ship by Friday, with the docs")).toBeInTheDocument();
    expect(firsts()).toEqual(["Too soon?", "Why cut?", "Which docs?", "About a removed line", "Which goals?"]);
    expect(screen.getByText("The block this was on is gone")).toBeInTheDocument();
    expect(screen.getByText("with the docs")).toBeInTheDocument();
    const cut = screen.getByRole("article", { name: "Comment by Me on “the old plan”" });
    expect(within(cut).getByText("the old plan").closest("del")).not.toBeNull();
  });

  it("shows the resolved ones instead, and those someone wrote in", async () => {
    const user = userEvent.setup();
    pane();
    await user.click(screen.getByRole("radio", { name: /Resolved/ }));
    expect(firsts()).toEqual(["Done here."]);
    await user.click(screen.getByRole("radio", { name: /Open/ }));
    await user.click(screen.getByRole("button", { name: "Whose comments" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Ana Lee" }));
    expect(firsts()).toEqual(["Too soon?"]);
  });

  it("opens a thread in the page when it is clicked, its words brought into view", async () => {
    const user = userEvent.setup();
    pane();
    await user.click(await screen.findByText("Which docs?"));
    expect(editor.scrollToThread).toHaveBeenCalledWith("c4");
    expect(usePageUi.getState()).toMatchObject({ focusThread: "c4", replyAsked: { thread: "c4" } });
    await user.click(screen.getByText("Which goals?"));
    expect(editor.scrollToBlock).toHaveBeenCalledWith("b2");
  });

  it("opens a thread whose block is gone under the page's title, where the page shows it, and answers it here", async () => {
    const user = userEvent.setup();
    pane();
    const gone = (await screen.findByText("About a removed line")).closest("article") as HTMLElement;
    expect(within(gone).getByRole("textbox", { name: "Reply…" })).toBeInTheDocument();
    await user.click(within(gone).getByRole("button", { name: "Show in the page" }));
    expect(usePageUi.getState().focusThread).toBe("c3");
    expect(editor.scrollToBlock).not.toHaveBeenCalled();
  });

  it("Esc in a reply box leaves it for the thread with what was typed; away from one, it closes the pane", async () => {
    const user = userEvent.setup();
    pane();
    const card = (await screen.findByText("Which goals?")).closest("article") as HTMLElement;
    const box = within(card).getByRole("textbox", { name: "Reply…" });
    await user.click(box);
    await user.keyboard("Not yet{Escape}");
    expect(card).toHaveFocus();
    expect(box).toHaveValue("Not yet");
    expect(usePageUi.getState().commentsOpen).toBe(true);
    await user.keyboard("{Escape}");
    expect(usePageUi.getState().commentsOpen).toBe(false);
  });

  it("has no box for a new comment: those are written where they go", () => {
    act(() => pageUi.startThread("b1"));
    pane();
    expect(screen.queryByRole("textbox", { name: /Comment on/ })).toBeNull();
  });
});
