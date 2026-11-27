// @vitest-environment jsdom
// The threads of a block where the page has no margin (docs/comments/
// block-threads.tsx): the block's mark opens them in a popover with the
// cursor in the first one's reply box; clicked words open their thread and
// leave the cursor in the text; a new thread is written there, and what was
// written stays with its block when another block's box opens and comes
// back with it; on a phone they open in a sheet.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Comment, Member, User, Workspace } from "@/types/core";
import { BlockThreads } from "@/docs/comments/block-threads";
import { useCommentDrafts } from "@/docs/comments/drafts";
import { pageUi, usePageUi } from "@/docs/page/state";
import { TooltipProvider } from "@/ui/tooltip";
import { WithQuery } from "@/test/query";

const me = { user_id: "u1", role: "owner", name: "Aram", kind: "person", handle: "aram" } as Member;

const comment = (id: string, body: string, at: number, more: Partial<Comment> = {}) =>
  ({
    id,
    doc_id: "d1",
    subject_type: "doc_block",
    subject_id: "b1",
    kind: "comment",
    author_id: "u1",
    body,
    created_at: at,
    ...more,
  }) as Comment;

let phone = false;

beforeEach(() => {
  phone = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width") && phone,
    addEventListener() {},
    removeEventListener() {},
  }));
  useCommentDrafts.setState({ drafts: {} });
  pageUi.reset();
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    comments: [
      comment("first", "Still three?", 1, { quote: "three phases" }),
      comment("second", "Which boss?", 2),
      comment("reply", "Yes, three.", 3, { parent_id: "first" }),
      comment("elsewhere", "Which gate?", 4, { subject_id: "b2" }),
    ],
  });
});
afterEach(() => vi.unstubAllGlobals());

function show() {
  const text = createRef<HTMLDivElement>();
  render(
    <WithQuery>
      <TooltipProvider>
        <div ref={text}>
          <div className="qd-editor bn-editor" tabIndex={-1}>
            <div className="bn-block-outer" data-id="b1">
              <div className="bn-block">
                <p className="bn-block-content">
                  The boss has{" "}
                  <span data-style-type="comment" data-value="first">
                    three phases
                  </span>
                </p>
              </div>
            </div>
            <button type="button" className="qd-thread-mark" data-block="b1">
              2
            </button>
          </div>
        </div>
        <BlockThreads docId="d1" projectId={undefined} text={text} />
      </TooltipProvider>
    </WithQuery>,
  );
}

const popover = () => screen.getByRole("dialog", { name: "Comments" });

describe("BlockThreads", () => {
  it("opens a block's threads from its mark, with every reply and the cursor in the first one's reply box", async () => {
    show();
    act(() => pageUi.showThread("b1"));
    const shown = within(popover());
    expect(shown.getByText("Still three?")).toBeInTheDocument();
    expect(shown.getByText("Yes, three.")).toBeInTheDocument();
    expect(shown.getByText("Which boss?")).toBeInTheDocument();
    expect(shown.queryByText("Which gate?")).toBeNull();
    const [first] = shown.getAllByRole("textbox", { name: "Reply…" });
    await vi.waitFor(() => expect(first).toHaveFocus());
  });

  it("opens the thread of words clicked and leaves the cursor in the text", () => {
    show();
    const text = document.querySelector<HTMLElement>(".bn-editor");
    text?.focus();
    act(() => pageUi.showWordsThread("first"));
    expect(within(popover()).getByRole("article", { name: /three phases/ })).toHaveAttribute("aria-current", "true");
    expect(text).toHaveFocus();
  });

  it("closes on Esc, the cursor back on the block's mark", async () => {
    const user = userEvent.setup();
    show();
    act(() => pageUi.showThread("b1"));
    await vi.waitFor(() => expect(within(popover()).getAllByRole("textbox")[0]).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(usePageUi.getState().focusBlock).toBeNull();
    expect(document.querySelector(".qd-thread-mark")).toHaveFocus();
  });

  it("writes a new thread there, its draft kept with its block when another opens, and back with it", async () => {
    const user = userEvent.setup();
    show();
    act(() => pageUi.startThread("b1"));
    const box = within(popover()).getByRole("textbox", { name: "Comment on this block…" });
    await vi.waitFor(() => expect(box).toHaveFocus());
    await user.keyboard("About the boss");
    act(() => pageUi.startThread("b2"));
    expect(within(popover()).getByRole("textbox", { name: "Comment on this block…" })).toHaveValue("");
    act(() => pageUi.startThread("b1"));
    expect(within(popover()).getByRole("textbox", { name: "Comment on this block…" })).toHaveValue("About the boss");
  });

  it("opens in a sheet on a phone", () => {
    phone = true;
    show();
    act(() => pageUi.showThread("b1"));
    const sheet = screen.getByRole("dialog", { name: "Comments" });
    expect(within(sheet).getByText("Still three?")).toBeInTheDocument();
  });
});
