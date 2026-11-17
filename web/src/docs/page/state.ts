// What is open around the page on screen: the comments column, the block
// or the words a new comment is being written on, the thread shown or
// pointed at, whether edits are still on their way.

import { create } from "zustand";
import type { SaveState } from "@/docs/editor/sync";
import type { Words } from "@/docs/editor/words";

interface PageUi {
  commentsOpen: boolean;
  /** The block a new thread is being started on. */
  draftBlock: string | null;
  /** The words of that block (and maybe the next ones) it is on; null for the block as a whole. */
  draftWords: Words | null;
  /** The block whose threads should be shown first. */
  focusBlock: string | null;
  /** The thread shown first: the one whose words were clicked. */
  focusThread: string | null;
  /** The thread the pointer is on, in the column or on its words: both light up. */
  litThread: string | null;
  showResolved: boolean;
  /**
   * Asks for the page's own comment box to take the cursor (Ctrl+M away
   * from the text). Counted up, so that each ask is seen; 0 when none is
   * waiting.
   */
  pageBoxAsked: number;
  /** By page id. */
  saving: Record<string, SaveState>;
}

export const usePageUi = create<PageUi>(() => ({
  commentsOpen: false,
  draftBlock: null,
  draftWords: null,
  focusBlock: null,
  focusThread: null,
  litThread: null,
  showResolved: false,
  pageBoxAsked: 0,
  saving: {},
}));

export const pageUi = {
  toggleComments: () =>
    usePageUi.setState((s) => ({ commentsOpen: !s.commentsOpen, draftBlock: null, draftWords: null, pageBoxAsked: 0 })),
  closeComments: () =>
    usePageUi.setState({
      commentsOpen: false,
      draftBlock: null,
      draftWords: null,
      focusBlock: null,
      focusThread: null,
      pageBoxAsked: 0,
    }),
  /** Opens the comments with the cursor in the box for a comment on the page as a whole. */
  commentOnPage: () =>
    usePageUi.setState((s) => ({
      commentsOpen: true,
      draftBlock: null,
      draftWords: null,
      showResolved: false,
      pageBoxAsked: s.pageBoxAsked + 1,
    })),
  /** Starts a thread on a block, or on words of it when they are given. */
  startThread: (blockId: string, words?: Words) =>
    usePageUi.setState({
      commentsOpen: true,
      draftBlock: blockId,
      draftWords: words ?? null,
      focusBlock: blockId,
      focusThread: null,
      showResolved: false,
    }),
  endDraft: () => usePageUi.setState({ draftBlock: null, draftWords: null }),
  /** Shows the threads on a block first. */
  showThread: (blockId: string) =>
    usePageUi.setState({
      commentsOpen: true,
      focusBlock: blockId,
      focusThread: null,
      draftBlock: null,
      draftWords: null,
      showResolved: false,
    }),
  /** Shows one thread first: the one on the words clicked. */
  showWordsThread: (threadId: string) =>
    usePageUi.setState({
      commentsOpen: true,
      focusThread: threadId,
      focusBlock: null,
      draftBlock: null,
      draftWords: null,
      showResolved: false,
    }),
  lightThread: (threadId: string | null) =>
    usePageUi.setState((s) => (s.litThread === threadId ? s : { litThread: threadId })),
  setShowResolved: (showResolved: boolean) => usePageUi.setState({ showResolved }),
  setSaving: (docId: string, state: SaveState) =>
    usePageUi.setState((s) => (s.saving[docId] === state ? s : { saving: { ...s.saving, [docId]: state } })),
};
