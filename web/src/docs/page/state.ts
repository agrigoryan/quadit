// What is open around the page on screen: the pages' editors, the comments
// pane, the block or the words a new comment is being written on, the
// thread shown or pointed at, the page whose own comment box is open, what
// should take the cursor next, whether edits are still on their way.
//
// A thread is always opened in place, wherever the page shows it: a card in
// the margin beside its words, the popover at its block where there is no
// margin, or the page's own discussion under the title. Which of these the
// page has is the page's business (page-body.tsx); the pane is the one list
// of every thread, opened only by asking for it.

import { create } from "zustand";
import type { EditorHandle } from "@/docs/editor/editor";
import type { SaveState } from "@/docs/editor/sync";
import type { Words } from "@/docs/editor/words";

interface PageUi {
  /** The editors drawn, by page id: the page shown, and a database row's side peek. */
  editors: Record<string, EditorHandle>;
  /** The comments pane: every thread of the page in one list. */
  commentsOpen: boolean;
  /** The page a new thread is being started on (a row's side peek is a page too). */
  draftDoc: string | null;
  /** The block a new thread is being started on. */
  draftBlock: string | null;
  /** The words of that block (and maybe the next ones) it is on; null for the block as a whole. */
  draftWords: Words | null;
  /** The block whose threads are open (its comment mark was clicked). */
  focusBlock: string | null;
  /** The thread open: its words were clicked, its card was, or it was picked from a list. */
  focusThread: string | null;
  /** The thread the pointer is on, beside the text or on its words: both light up. */
  litThread: string | null;
  showResolved: boolean;
  /** The page whose box for a comment on the page as a whole is open. */
  pageBox: string | null;
  /**
   * What should take the cursor, asked for just now: "reply <thread>" (its
   * reply box), "block" (the reply box of the first thread of `focusBlock`),
   * "draft" (the new thread's box), "page <page>" (the page's own box),
   * "pane" (the comments pane). The box takes it and says so (cursorTaken),
   * so that one drawn again later (the page laid out anew) does not take
   * the cursor from wherever it is by then.
   */
  cursorAsked: string | null;
  /** By page id. */
  saving: Record<string, SaveState>;
}

export const usePageUi = create<PageUi>(() => ({
  editors: {},
  commentsOpen: false,
  draftDoc: null,
  draftBlock: null,
  draftWords: null,
  focusBlock: null,
  focusThread: null,
  litThread: null,
  showResolved: false,
  pageBox: null,
  cursorAsked: null,
  saving: {},
}));

const nothingOpen = {
  draftDoc: null,
  draftBlock: null,
  draftWords: null,
  focusBlock: null,
  focusThread: null,
  cursorAsked: null,
};

export const pageUi = {
  /** A page's editor drawn (`editor`), or gone (null). */
  setEditor: (docId: string, editor: EditorHandle | null) =>
    usePageUi.setState((s) => {
      const { [docId]: _was, ...others } = s.editors;
      return { editors: editor ? { ...others, [docId]: editor } : others };
    }),
  /** Opens the pane of every thread, the open ones shown, with the cursor in it ("See all"). */
  openComments: () => usePageUi.setState({ commentsOpen: true, showResolved: false, cursorAsked: "pane" }),
  closeComments: () => usePageUi.setState({ commentsOpen: false }),
  /** Another page: nothing of this one's stays open. */
  reset: () => usePageUi.setState({ ...nothingOpen, commentsOpen: false, pageBox: null, litThread: null }),
  /** Opens a page's box for a comment on it as a whole, with the cursor in it. */
  commentOnPage: (docId: string) =>
    usePageUi.setState({ ...nothingOpen, pageBox: docId, cursorAsked: `page ${docId}` }),
  /** Puts the page's comment box away; what was written in it is kept (drafts.ts). */
  closePageBox: () => usePageUi.setState({ pageBox: null }),
  /** Starts a thread on a block of a page, or on words of it when they are given, with the cursor in its box. */
  startThread: (docId: string, blockId: string, words?: Words) =>
    usePageUi.setState({
      ...nothingOpen,
      draftDoc: docId,
      draftBlock: blockId,
      draftWords: words ?? null,
      cursorAsked: "draft",
    }),
  endDraft: () => usePageUi.setState({ draftDoc: null, draftBlock: null, draftWords: null }),
  /** Opens the threads on a block (its comment mark), the cursor in the first one's reply box. */
  showThread: (blockId: string) => usePageUi.setState({ ...nothingOpen, focusBlock: blockId, cursorAsked: "block" }),
  /** Opens the thread whose words were clicked. The cursor stays in the text, where it was put. */
  showWordsThread: (threadId: string) => usePageUi.setState({ ...nothingOpen, focusThread: threadId }),
  /**
   * Opens a thread with the cursor in its reply box. Scrolling it into view
   * is the caller's, who knows where it is.
   */
  openThread: (threadId: string) =>
    usePageUi.setState({ ...nothingOpen, focusThread: threadId, cursorAsked: `reply ${threadId}` }),
  /** No thread is open any more (Esc, a click away from it, or it is gone). */
  leaveThread: () => usePageUi.setState({ focusThread: null, focusBlock: null, cursorAsked: null }),
  /** What was asked to take the cursor has it. */
  cursorTaken: () => usePageUi.setState({ cursorAsked: null }),
  lightThread: (threadId: string | null) =>
    usePageUi.setState((s) => (s.litThread === threadId ? s : { litThread: threadId })),
  setShowResolved: (showResolved: boolean) => usePageUi.setState({ showResolved }),
  setSaving: (docId: string, state: SaveState) =>
    usePageUi.setState((s) => (s.saving[docId] === state ? s : { saving: { ...s.saving, [docId]: state } })),
};
