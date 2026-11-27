// What is open around the page on screen: the page's editor, the comments
// pane, the block or the words a new comment is being written on, the
// thread shown or pointed at, whether edits are still on their way.
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
  /** The editor of the page shown (not of a row's side peek); null until it has drawn. */
  editor: EditorHandle | null;
  /** The comments pane: every thread of the page in one list. */
  commentsOpen: boolean;
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
  /**
   * Asks for a reply box to take the cursor: the thread's, or with no
   * thread the first open one of `focusBlock`. Counted up, so that each ask
   * is seen.
   */
  replyAsked: { thread: string | null; n: number } | null;
  /**
   * Asks for the box of a new comment on the page as a whole to open and
   * take the cursor ("Add comment", or Ctrl+M away from the text). Counted
   * up, so that each ask is seen; 0 while the box is put away.
   */
  pageBoxAsked: number;
  /** By page id. */
  saving: Record<string, SaveState>;
}

export const usePageUi = create<PageUi>(() => ({
  editor: null,
  commentsOpen: false,
  draftBlock: null,
  draftWords: null,
  focusBlock: null,
  focusThread: null,
  litThread: null,
  showResolved: false,
  replyAsked: null,
  pageBoxAsked: 0,
  saving: {},
}));

const nothingOpen = { draftBlock: null, draftWords: null, focusBlock: null, focusThread: null, replyAsked: null };

export const pageUi = {
  /** For the editor's `handle`: the page's editor drawn, or gone. */
  setEditor: (editor: EditorHandle | null) => usePageUi.setState({ editor }),
  /** Opens the pane of every thread, the open ones shown ("See all"). */
  openComments: () => usePageUi.setState({ commentsOpen: true, showResolved: false }),
  closeComments: () => usePageUi.setState({ commentsOpen: false }),
  /** Another page: nothing of this one's stays open. */
  reset: () => usePageUi.setState({ ...nothingOpen, commentsOpen: false, pageBoxAsked: 0, litThread: null }),
  /** Opens the box for a comment on the page as a whole, with the cursor in it. */
  commentOnPage: () => usePageUi.setState((s) => ({ ...nothingOpen, pageBoxAsked: s.pageBoxAsked + 1 })),
  /** Puts the page's comment box away; what was written in it is kept (drafts.ts). */
  closePageBox: () => usePageUi.setState({ pageBoxAsked: 0 }),
  /** Starts a thread on a block, or on words of it when they are given. */
  startThread: (blockId: string, words?: Words) =>
    usePageUi.setState({ ...nothingOpen, draftBlock: blockId, draftWords: words ?? null }),
  endDraft: () => usePageUi.setState({ draftBlock: null, draftWords: null }),
  /** Opens the threads on a block (its comment mark), the cursor in the first one's reply box. */
  showThread: (blockId: string) =>
    usePageUi.setState((s) => ({
      ...nothingOpen,
      focusBlock: blockId,
      replyAsked: { thread: null, n: (s.replyAsked?.n ?? 0) + 1 },
    })),
  /** Opens the thread whose words were clicked. The cursor stays in the text, where it was put. */
  showWordsThread: (threadId: string) => usePageUi.setState({ ...nothingOpen, focusThread: threadId }),
  /**
   * Opens a thread with the cursor in its reply box. Scrolling it into view
   * is the caller's, who knows where it is.
   */
  openThread: (threadId: string) =>
    usePageUi.setState((s) => ({
      ...nothingOpen,
      focusThread: threadId,
      replyAsked: { thread: threadId, n: (s.replyAsked?.n ?? 0) + 1 },
    })),
  /** No thread is open any more (Esc, or a click away from it). */
  leaveThread: () => usePageUi.setState({ focusThread: null, focusBlock: null, replyAsked: null }),
  lightThread: (threadId: string | null) =>
    usePageUi.setState((s) => (s.litThread === threadId ? s : { litThread: threadId })),
  setShowResolved: (showResolved: boolean) => usePageUi.setState({ showResolved }),
  setSaving: (docId: string, state: SaveState) =>
    usePageUi.setState((s) => (s.saving[docId] === state ? s : { saving: { ...s.saving, [docId]: state } })),
};
