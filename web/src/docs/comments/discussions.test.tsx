// @vitest-environment jsdom
// The Discussions list in a page's header (docs/comments/discussions.tsx):
// the open threads, those last written in first, with who wrote them and
// what they are on; a thread picked is brought into view and opens where
// the page shows it, the cursor asked into its reply box; "See all" opens
// the comments pane.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Comment, Member, User, Workspace } from "@/types/core";
import { Discussions } from "@/docs/comments/discussions";
import { useThreadReadings } from "@/docs/comments/threads";
import type { EditorHandle } from "@/docs/editor/editor";
import { pageUi, usePageUi } from "@/docs/page/state";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "owner", name: "Aram", kind: "person", handle: "aram" } as Member;

const comment = (id: string, block: string, body: string, at: number, more: Partial<Comment> = {}) =>
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

/** The page's editor, of which only scrolling is asked here. */
const editor = { scrollToBlock: vi.fn(), scrollToThread: vi.fn() } as unknown as EditorHandle; // a partial fake

/** The page's text as read for its threads: b2 above b1, the words of c3 in b1. */
const reading = {
  order: ["b2", "b1"],
  texts: new Map([
    ["b1", "Ship by Friday"],
    ["b2", "Goals"],
  ]),
  words: new Map([["c3", "by Friday"]]),
};

beforeEach(() => {
  vi.clearAllMocks();
  pageUi.reset();
  pageUi.setEditor("d1", editor);
  useThreadReadings.setState({ byPage: { d1: reading } });
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    comments: [
      comment("c1", "b1", "Too soon?", 1),
      comment("c2", "b2", "Which goals?", 2),
      comment("c3", "b1", "Which Friday?", 3, { quote: "by Friday" }),
      comment("c4", "d1", "Keep it short.", 4, { subject_type: "doc" }),
      comment("c5", "b1", "Done.", 5, { resolved_at: 6 }),
    ],
  });
});

const open = async () => {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <Discussions docId="d1" />
    </TooltipProvider>,
  );
  await user.click(screen.getByRole("button", { name: /Comments/ }));
  return { user, list: screen.getByRole("dialog", { name: "Discussions" }) };
};

describe("Discussions", () => {
  it("counts the open threads on the button, and lists them last written in first, with what they are on", async () => {
    const { list } = await open();
    expect(screen.getByRole("button", { name: /Comments/ })).toHaveTextContent("4");
    const rows = within(list)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(rows).toEqual([
      expect.stringMatching(/Keep it short\.On the page$/),
      expect.stringMatching(/Which Friday\?by Friday$/),
      expect.stringMatching(/Aram.*Which goals\?Goals$/),
      expect.stringMatching(/Too soon\?Ship by Friday$/),
      "See all",
    ]);
  });

  it("brings a thread on words picked into view and opens it there, the cursor asked into its reply box", async () => {
    const { user, list } = await open();
    await user.click(within(list).getByRole("button", { name: /Which Friday\?/ }));
    expect(editor.scrollToThread).toHaveBeenCalledWith("c3");
    const state = usePageUi.getState();
    expect(state.focusThread).toBe("c3");
    expect(state.cursorAsked).toBe("reply c3");
    expect(state.commentsOpen).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Discussions" })).toBeNull();
  });

  it("brings a thread on a block picked into view", async () => {
    const { user, list } = await open();
    await user.click(within(list).getByRole("button", { name: /Which goals\?/ }));
    expect(editor.scrollToBlock).toHaveBeenCalledWith("b2");
    expect(usePageUi.getState()).toMatchObject({ focusThread: "c2", commentsOpen: false });
  });

  it("opens a thread on the page as a whole where it is, under the title, not in a list", async () => {
    const { user, list } = await open();
    await user.click(within(list).getByRole("button", { name: /Keep it short\./ }));
    expect(usePageUi.getState()).toMatchObject({ commentsOpen: false, focusThread: "c4" });
  });

  it("See all opens the comments pane", async () => {
    const { user, list } = await open();
    await user.click(within(list).getByRole("button", { name: "See all" }));
    expect(usePageUi.getState()).toMatchObject({ commentsOpen: true, showResolved: false });
  });
});
