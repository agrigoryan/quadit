// What a draft in a page's comment boxes is for, as the key it is kept
// under (data/comment-drafts.ts keeps them): a new thread on a block or on
// words of it, a reply to a thread, a comment on the page.

import type { Words } from "@/docs/editor/words";

export const draftFor = {
  reply: (threadId: string) => `reply ${threadId}`,
  /**
   * A new thread: on a block, or on words of it. Words are told apart by
   * where they are and what they read: other words at the same place, or
   * the same words moved by text typed before them, start a draft of their
   * own (the one written before stays under its own key).
   */
  thread: (blockId: string, words?: Words | null) =>
    words ? `words ${blockId} ${words.start} ${words.end} ${words.endBlock ?? ""} ${words.quote}` : `block ${blockId}`,
  page: (docId: string) => `page ${docId}`,
};
