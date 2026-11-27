// @vitest-environment jsdom
// The threads beside a page's text (docs/comments/margin.tsx): each open
// thread on words or a block is a card level with them, none over another;
// threads on the page, on words taken out and resolved ones are not there;
// a card opens with its replies and the cursor in its reply box, Esc closes
// it again with the cursor on the card, a click in the text away from its
// words does too; a new thread is written beside its block; what was
// written stays with what it is for; a page whose threads' blocks are gone
// is told there is no card to make room for. jsdom lays nothing out: each
// element's place is its data-top, each card 60px tall.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Comment, Member, User, Workspace } from "@/types/core";
import { useCommentDrafts } from "@/docs/comments/drafts";
import { Margin } from "@/docs/comments/margin";
import type { EditorHandle } from "@/docs/editor/editor";
import { pageUi, usePageUi } from "@/docs/page/state";
import { TooltipProvider } from "@/ui/tooltip";

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

let changed = () => {};
const editor = {
  onChange: (listener: () => void) => {
    changed = listener;
    return () => {};
  },
} as unknown as EditorHandle; // only onChange is asked of it here

const box = (el: Element) => {
  const top = Number(el.getAttribute("data-top") ?? 0);
  return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top } as DOMRect;
};

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.card ? 60 : 0;
    },
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { addEventListener() {}, removeEventListener() {} },
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return box(this);
  });
  // Something inside a folded toggle has no boxes.
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.closest("[data-folded]") ? [] : [box(this)]) as unknown as DOMRectList; // a list jsdom cannot make
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  pageUi.reset();
  useCommentDrafts.setState({ drafts: {} });
  pageUi.setEditor(editor);
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    comments: [
      comment("words", "Still three?", 1, { quote: "three phases" }),
      comment("block", "Which boss?", 2, { subject_id: "b2" }),
      comment("close", "And the fourth?", 3, { quote: "phases", subject_id: "b1" }),
      comment("reply1", "Yes, three.", 4, { parent_id: "words" }),
      comment("reply2", "Fine by me.", 5, { parent_id: "words" }),
      comment("page", "Short page.", 6, { subject_type: "doc", subject_id: "d1" }),
      comment("cut", "Why cut?", 7, { subject_type: "doc", subject_id: "d1", quote: "old plan", detached_at: 8 }),
      comment("done", "Fixed.", 9, { subject_id: "b2", resolved_at: 10 }),
      comment("folded", "Inside the toggle", 11, { subject_id: "b4" }),
    ],
  });
});

/** The page's text: words of two threads on one line of b1, then b2 lower down, and b4 folded in the toggle b3. */
function show(onCards?: (any: boolean) => void) {
  const text = createRef<HTMLDivElement>();
  const view = render(
    <TooltipProvider>
      <div ref={text}>
        <div className="qd-editor bn-editor" tabIndex={-1}>
          <div className="bn-block-outer" data-id="b1" data-top="100">
            <div className="bn-block">
              <p className="bn-block-content">
                The boss has{" "}
                <span data-style-type="comment" data-value="words" data-top="110">
                  three{" "}
                </span>
                <span data-style-type="comment" data-value="words close" data-top="110">
                  phases
                </span>
              </p>
            </div>
          </div>
          <div className="bn-block-outer" data-id="b2" data-top="400">
            <div className="bn-block">
              <p className="bn-block-content">Then it runs.</p>
            </div>
          </div>
          <div className="bn-block-outer" data-id="b3" data-top="600">
            <div className="bn-block">
              <p className="bn-block-content">More</p>
              <div className="bn-block-group" data-folded>
                <div className="bn-block-outer" data-id="b4" data-top="0">
                  <div className="bn-block">
                    <p className="bn-block-content">Hidden</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Margin docId="d1" projectId={undefined} text={text} onCards={onCards} />
    </TooltipProvider>,
  );
  return { ...view, text };
}

const card = (name: RegExp | string) => screen.getByRole("article", { name });
const top = (el: HTMLElement) => {
  const wrap = el.closest<HTMLElement>("[data-card]");
  return Number(/translateY\((-?\d+)px\)/.exec(wrap?.style.transform ?? "")?.[1] ?? NaN);
};
/** Lets the measuring frame run. */
const frame = () => act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));

describe("the margin", () => {
  it("puts a card for each open thread on words or a block level with them, and none for the others", async () => {
    show();
    await frame();
    expect(top(card("Comment by Aram on “three phases”"))).toBe(110);
    expect(top(card("Comment by Aram on “Then it runs.”"))).toBe(400);
    for (const body of ["Short page.", "Why cut?", "Fixed."]) expect(screen.queryByText(body)).toBeNull();
  });

  it("pushes a card down below one it would overlap, in the order the page reads", async () => {
    show();
    await frame();
    const first = card("Comment by Aram on “three phases”");
    const second = card("Comment by Aram on “phases”");
    expect(top(second)).toBe(110 + 60 + 8);
    const order = screen.getAllByRole("article").map((a) => a.getAttribute("data-thread"));
    expect(order.indexOf("words")).toBeLessThan(order.indexOf("close"));
    expect(top(first)).toBe(110);
  });

  it("puts a card on a block folded away beside the block that shows around it", async () => {
    show();
    await frame();
    expect(top(card("Comment by Aram on “Hidden”"))).toBe(600);
  });

  it("shows a closed card short, and opens it with every reply and the cursor in its reply box", async () => {
    const user = userEvent.setup();
    show();
    await frame();
    const words = card("Comment by Aram on “three phases”");
    expect(within(words).getByText("2 replies")).toBeInTheDocument();
    expect(within(words).queryByText("Yes, three.")).toBeNull();

    await user.click(within(words).getByText("Still three?"));
    await frame();
    expect(words).toHaveAttribute("aria-current", "true");
    expect(within(words).getByText("Yes, three.")).toBeInTheDocument();
    expect(within(words).getByText("Fine by me.")).toBeInTheDocument();
    expect(within(words).getByRole("textbox", { name: "Reply…" })).toHaveFocus();
  });

  it("keeps the open card level with its words and moves the one above out of its way", async () => {
    const user = userEvent.setup();
    show();
    await frame();
    const second = card("Comment by Aram on “phases”");
    await user.click(within(second).getByRole("button", { name: "Reply…" }));
    await frame();
    expect(top(second)).toBe(110);
    expect(top(card("Comment by Aram on “three phases”"))).toBe(110 - 8 - 60);
  });

  it("Esc in the reply box closes the card and leaves the cursor on it, not nowhere", async () => {
    const user = userEvent.setup();
    show();
    await frame();
    const words = card("Comment by Aram on “three phases”");
    await user.click(within(words).getByRole("button", { name: "Reply…" }));
    const reply = within(words).getByRole("textbox", { name: "Reply…" });
    expect(reply).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(usePageUi.getState().focusThread).toBeNull();
    expect(within(words).getByRole("button", { name: "Reply…" })).toHaveFocus();
  });

  it("a click in the text away from the open thread's words closes it; on its words, it stays", async () => {
    const user = userEvent.setup();
    show();
    await frame();
    act(() => pageUi.showWordsThread("words"));
    await user.click(screen.getAllByText(/three/)[0] as HTMLElement);
    expect(usePageUi.getState().focusThread).toBe("words");
    await user.click(screen.getByText("Then it runs."));
    expect(usePageUi.getState().focusThread).toBeNull();
  });

  it("writes a new thread beside its block, and puts its box away on Esc", async () => {
    const user = userEvent.setup();
    show();
    act(() => pageUi.startThread("b2"));
    await frame();
    const draft = screen.getByRole("textbox", { name: "Comment on this block…" });
    expect(draft).toHaveFocus();
    expect(top(draft)).toBe(400);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Comment on this block…" })).toBeNull();
    expect(usePageUi.getState().draftBlock).toBeNull();
  });

  it("keeps a new thread's draft with its block: another block's box is empty, and the first comes back", async () => {
    const user = userEvent.setup();
    show();
    act(() => pageUi.startThread("b2"));
    await frame();
    await user.keyboard("About the run");
    act(() => pageUi.startThread("b1"));
    await frame();
    expect(screen.getByRole("textbox", { name: "Comment on this block…" })).toHaveValue("");
    act(() => pageUi.startThread("b2"));
    await frame();
    expect(screen.getByRole("textbox", { name: "Comment on this block…" })).toHaveValue("About the run");
  });

  it("keeps a reply begun in a card when the card closes, by a click away, Esc or another card", async () => {
    const user = userEvent.setup();
    show();
    await frame();
    const words = card("Comment by Aram on “three phases”");
    const open = () =>
      user.click(within(card("Comment by Aram on “three phases”")).getByRole("button", { name: /Reply…|Not sure/ }));
    await open();
    await user.keyboard("Not sure");
    await user.click(screen.getByText("Then it runs."));
    expect(within(words).getByRole("button", { name: "Not sure" })).toBeInTheDocument();
    await open();
    expect(within(words).getByRole("textbox", { name: "Reply…" })).toHaveValue("Not sure");
    await user.keyboard("{Escape}");
    await open();
    await user.click(within(card("Comment by Aram on “phases”")).getByRole("button", { name: "Reply…" }));
    await open();
    expect(within(words).getByRole("textbox", { name: "Reply…" })).toHaveValue("Not sure");
  });

  it("opens the first thread on a block whose mark was clicked, the cursor in its reply box", async () => {
    show();
    await frame();
    act(() => pageUi.showThread("b2"));
    await frame();
    const block = card("Comment by Aram on “Then it runs.”");
    expect(block).toHaveAttribute("aria-current", "true");
    expect(within(block).getByRole("textbox", { name: "Reply…" })).toHaveFocus();
  });

  it("tells the page it has no card when the threads' blocks are all gone", async () => {
    clearStore();
    loadBootstrap("acme", {
      seq: 1,
      me,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
      members: [me],
      comments: [comment("lost", "On a block taken out", 1, { subject_id: "gone" })],
    });
    const onCards = vi.fn();
    show(onCards);
    await frame();
    expect(onCards).toHaveBeenLastCalledWith(false);
  });

  it("resolved from its open card, the thread leaves the margin and the cursor goes back to the text", async () => {
    const user = userEvent.setup();
    const { container } = show();
    await frame();
    const words = card("Comment by Aram on “three phases”");
    await user.click(within(words).getByRole("button", { name: "Reply…" }));
    await user.click(within(words).getByRole("button", { name: "Resolve" }));
    expect(screen.queryByRole("article", { name: "Comment by Aram on “three phases”" })).toBeNull();
    expect(container.querySelector(".bn-editor")).toHaveFocus();
    expect(usePageUi.getState().focusThread).toBeNull();
  });

  it("follows the words as the text changes at once, and slides the cards when another one opens", async () => {
    const user = userEvent.setup();
    const { container } = show();
    await frame();
    const words = card("Comment by Aram on “three phases”");
    const slides = (el: HTMLElement) => !!el.closest("[data-card]")?.className.includes("transition-transform");
    for (const el of container.querySelectorAll('[data-value~="words"]')) el.setAttribute("data-top", "250");
    act(() => changed());
    await frame();
    expect(top(words)).toBe(250);
    expect(slides(words)).toBe(false);

    await user.click(within(card("Comment by Aram on “phases”")).getByRole("button", { name: "Reply…" }));
    await frame();
    expect(slides(words)).toBe(true);
  });
});
