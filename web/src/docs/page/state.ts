// What is open around the page on screen: the comments column, the block a
// new comment is being written on, whether edits are still on their way.

import { create } from "zustand";
import type { SaveState } from "@/docs/editor/sync";

interface PageUi {
  commentsOpen: boolean;
  /** The block a new thread is being started on. */
  draftBlock: string | null;
  /** The block whose threads should be shown first. */
  focusBlock: string | null;
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
  focusBlock: null,
  showResolved: false,
  pageBoxAsked: 0,
  saving: {},
}));

export const pageUi = {
  toggleComments: () =>
    usePageUi.setState((s) => ({ commentsOpen: !s.commentsOpen, draftBlock: null, pageBoxAsked: 0 })),
  closeComments: () => usePageUi.setState({ commentsOpen: false, draftBlock: null, focusBlock: null, pageBoxAsked: 0 }),
  /** Opens the comments with the cursor in the box for a comment on the page as a whole. */
  commentOnPage: () =>
    usePageUi.setState((s) => ({
      commentsOpen: true,
      draftBlock: null,
      showResolved: false,
      pageBoxAsked: s.pageBoxAsked + 1,
    })),
  startThread: (blockId: string) =>
    usePageUi.setState({ commentsOpen: true, draftBlock: blockId, focusBlock: blockId, showResolved: false }),
  endDraft: () => usePageUi.setState({ draftBlock: null }),
  showThread: (blockId: string) =>
    usePageUi.setState({ commentsOpen: true, focusBlock: blockId, draftBlock: null, showResolved: false }),
  setShowResolved: (showResolved: boolean) => usePageUi.setState({ showResolved }),
  setSaving: (docId: string, state: SaveState) =>
    usePageUi.setState((s) => (s.saving[docId] === state ? s : { saving: { ...s.saving, [docId]: state } })),
};
