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
  /** By page id. */
  saving: Record<string, SaveState>;
}

export const usePageUi = create<PageUi>(() => ({ commentsOpen: false, draftBlock: null, focusBlock: null, showResolved: false, saving: {} }));

export const pageUi = {
  toggleComments: () => usePageUi.setState((s) => ({ commentsOpen: !s.commentsOpen, draftBlock: null })),
  closeComments: () => usePageUi.setState({ commentsOpen: false, draftBlock: null, focusBlock: null }),
  startThread: (blockId: string) => usePageUi.setState({ commentsOpen: true, draftBlock: blockId, focusBlock: blockId, showResolved: false }),
  endDraft: () => usePageUi.setState({ draftBlock: null }),
  showThread: (blockId: string) => usePageUi.setState({ commentsOpen: true, focusBlock: blockId, draftBlock: null, showResolved: false }),
  setShowResolved: (showResolved: boolean) => usePageUi.setState({ showResolved }),
  setSaving: (docId: string, state: SaveState) => usePageUi.setState((s) => (s.saving[docId] === state ? s : { saving: { ...s.saving, [docId]: state } })),
};
