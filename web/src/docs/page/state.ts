// What is open around the page on screen: the page's editor, whether its
// threads are in the margin or in the comments column, the block or the
// words a new comment is being written on, the thread shown or pointed at,
// whether edits are still on their way.
//
// Where a thread opens is decided here: in the margin beside its words when
// the page has room for one and the column is not open, else in the column.

import { create } from "zustand";
import type { EditorHandle } from "@/docs/editor/editor";
import type { SaveState } from "@/docs/editor/sync";
import type { Words } from "@/docs/editor/words";

interface PageUi {
  /** The editor of the page shown (not of a row's side peek); null until it has drawn. */
  editor: EditorHandle | null;
  /** The page has room beside its text for threads in a margin (page-body.tsx says how much). */
  margin: boolean;
  /** The comments column: every thread in a list, with the box for a comment on the page. */
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
   * Asks for the reply box of a thread to take the cursor (a thread picked
   * from the Discussions list, or its card opened). Counted up, so that
   * each ask is seen.
   */
  replyAsked: { thread: string; n: number } | null;
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
  editor: null,
  margin: false,
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

/** Opens the column unless a thread asked for has the margin to open in. */
const column = (s: PageUi, inText: boolean) => s.commentsOpen || !(inText && s.margin);

export const pageUi = {
  /** For the editor's `handle`: the page's editor drawn, or gone. */
  setEditor: (editor: EditorHandle | null) => usePageUi.setState({ editor }),
  setMargin: (margin: boolean) => usePageUi.setState((s) => (s.margin === margin ? s : { margin })),
  /** Opens the column of every thread, the open ones shown ("See all"). */
  openComments: () => usePageUi.setState({ commentsOpen: true, showResolved: false }),
  closeComments: () =>
    usePageUi.setState({
      commentsOpen: false,
      draftBlock: null,
      draftWords: null,
      focusBlock: null,
      focusThread: null,
      replyAsked: null,
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
    usePageUi.setState((s) => ({
      commentsOpen: column(s, true),
      draftBlock: blockId,
      draftWords: words ?? null,
      focusBlock: blockId,
      focusThread: null,
      showResolved: false,
    })),
  endDraft: () => usePageUi.setState({ draftBlock: null, draftWords: null }),
  /** Shows the threads on a block first. */
  showThread: (blockId: string) =>
    usePageUi.setState((s) => ({
      commentsOpen: column(s, true),
      focusBlock: blockId,
      focusThread: null,
      draftBlock: null,
      draftWords: null,
      showResolved: false,
    })),
  /** Shows one thread first: the one on the words clicked. The cursor stays in the text. */
  showWordsThread: (threadId: string) =>
    usePageUi.setState((s) => ({
      commentsOpen: column(s, true),
      focusThread: threadId,
      focusBlock: null,
      draftBlock: null,
      draftWords: null,
      showResolved: false,
    })),
  /**
   * Opens a thread with the cursor in its reply box: in the margin when it
   * is on the page's text (`inText`) and there is a margin, else in the
   * column. Scrolling its words into view is the caller's, who knows where
   * they are.
   */
  openThread: (threadId: string, inText: boolean) =>
    usePageUi.setState((s) => ({
      commentsOpen: column(s, inText),
      focusThread: threadId,
      focusBlock: null,
      draftBlock: null,
      draftWords: null,
      showResolved: false,
      replyAsked: { thread: threadId, n: (s.replyAsked?.n ?? 0) + 1 },
    })),
  /** No thread is the one shown any more (Esc, or a click in the text away from its words). */
  leaveThread: () => usePageUi.setState({ focusThread: null, focusBlock: null, replyAsked: null }),
  lightThread: (threadId: string | null) =>
    usePageUi.setState((s) => (s.litThread === threadId ? s : { litThread: threadId })),
  setShowResolved: (showResolved: boolean) => usePageUi.setState({ showResolved }),
  setSaving: (docId: string, state: SaveState) =>
    usePageUi.setState((s) => (s.saving[docId] === state ? s : { saving: { ...s.saving, [docId]: state } })),
};
