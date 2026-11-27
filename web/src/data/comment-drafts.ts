// What is being written in comment boxes that keep their drafts by what they
// are for (a page's: docs/comments/drafts.ts names what for): the text, and
// the files given, uploading or uploaded. A draft outlives its box and goes
// only when sent or cancelled. It is the signed-in member's, in the
// workspace it was written in: no one else signed in on this browser sees
// it, and signing out (auth/session.ts) lets go of them all.

import { create } from "zustand";
import { uploadWaiting, type WaitingFile } from "@/data/comment-files";
import { getState, useStore } from "@/data/store";

export interface CommentDraft {
  body: string;
  files: WaitingFile[];
}

export const EMPTY_DRAFT: CommentDraft = { body: "", files: [] };

/** The drafts by whose they are and what for; one with nothing in it is not kept. */
const useDrafts = create<{ drafts: Record<string, CommentDraft> }>(() => ({ drafts: {} }));

/** Whose a draft is: the member signed in, in the workspace open. */
const whose = (slug: string, userId: string | undefined) => `${slug} ${userId ?? ""}`;
const keyOf = (key: string) => {
  const { slug, me } = getState();
  return `${whose(slug, me?.user_id)} ${key}`;
};

/** The draft for `key`, the signed-in member's; empty when there is none. */
export function useCommentDraft(key: string): CommentDraft {
  const owner = useStore((s) => whose(s.slug, s.me?.user_id));
  return useDrafts((s) => s.drafts[`${owner} ${key}`]) ?? EMPTY_DRAFT;
}

/** The same, read once (outside a component). */
export const commentDraft = (key: string): CommentDraft => useDrafts.getState().drafts[keyOf(key)] ?? EMPTY_DRAFT;

export function editDraft(key: string, change: (draft: CommentDraft) => CommentDraft) {
  editOwn(keyOf(key), change);
}

/** Edits a draft by its full key: an upload that lands later is still its writer's, whoever is signed in by then. */
function editOwn(full: string, change: (draft: CommentDraft) => CommentDraft) {
  useDrafts.setState((s) => {
    const next = change(s.drafts[full] ?? EMPTY_DRAFT);
    const { [full]: _was, ...others } = s.drafts;
    return { drafts: next.body === "" && next.files.length === 0 ? others : { ...others, [full]: next } };
  });
}

/** Uploads files into a draft; each shows as a chip that fills in when it lands, wherever the box is. */
export function addDraftFiles(key: string, files: File[]) {
  const full = keyOf(key);
  uploadWaiting(files, (change) => editOwn(full, (d) => ({ ...d, files: change(d.files) })));
}

/** Sent, or cancelled: the draft is gone. */
export function dropDraft(key: string) {
  editDraft(key, () => EMPTY_DRAFT);
}

/** Lets go of every draft, of everyone: the session ended. */
export function clearCommentDrafts() {
  useDrafts.setState({ drafts: {} });
}
