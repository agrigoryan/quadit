// What is being written in a page's comment boxes, kept by what it is for:
// a new thread on a block or on words of it, a reply to a thread, a comment
// on the page. A draft outlives its box (a card closed, another opened, Esc,
// the page laid out another way) and goes only when sent or cancelled.

import { create } from "zustand";
import { uploadWaiting, type WaitingFile } from "@/data/comment-files";
import type { Words } from "@/docs/editor/words";

export interface CommentDraft {
  body: string;
  files: WaitingFile[];
}

export const EMPTY_DRAFT: CommentDraft = { body: "", files: [] };

/** The drafts by what they are for (`draftFor`); one with nothing in it is not kept. */
export const useCommentDrafts = create<{ drafts: Record<string, CommentDraft> }>(() => ({ drafts: {} }));

/** What a draft is for, as the key it is kept under. */
export const draftFor = {
  reply: (threadId: string) => `reply ${threadId}`,
  thread: (blockId: string, words?: Words | null) =>
    words ? `words ${blockId} ${words.start} ${words.end} ${words.endBlock ?? ""}` : `block ${blockId}`,
  page: (docId: string) => `page ${docId}`,
};

export function editDraft(key: string, change: (draft: CommentDraft) => CommentDraft) {
  useCommentDrafts.setState((s) => {
    const next = change(s.drafts[key] ?? EMPTY_DRAFT);
    const { [key]: _gone, ...others } = s.drafts;
    return { drafts: next.body === "" && next.files.length === 0 ? others : { ...others, [key]: next } };
  });
}

/** Uploads files into a draft; each shows as a chip that fills in when it lands, wherever the box is. */
export function addDraftFiles(key: string, files: File[]) {
  uploadWaiting(files, (change) => editDraft(key, (d) => ({ ...d, files: change(d.files) })));
}

/** Sent, or cancelled: the draft is gone. */
export function dropDraft(key: string) {
  editDraft(key, () => EMPTY_DRAFT);
}
