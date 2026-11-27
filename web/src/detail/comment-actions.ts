// Writing comments: the unsent draft of each task's comment box (kept while
// the app is open, so moving between tasks loses nothing), and the changes
// that post, edit and delete a comment.

import type { Changes } from "@/types/changes.gen";
import { create } from "zustand";
import { newId } from "@/lib/ids";
import { send } from "@/data/mutate";
import { getState } from "@/data/store";
import type { Comment, FileRow, Task } from "@/types/core";
import { commentFiles, uploadWaiting, type WaitingFile } from "@/data/comment-files";

export interface Draft {
  body: string;
  files: WaitingFile[];
  /** Who the task should wait on once the comment is sent. */
  handTo: string | null;
}

export const EMPTY_DRAFT: Draft = { body: "", files: [], handTo: null };

export const useDrafts = create<{ drafts: Record<string, Draft> }>(() => ({ drafts: {} }));

export function editDraft(taskId: string, change: (draft: Draft) => Draft) {
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [taskId]: change(s.drafts[taskId] ?? EMPTY_DRAFT) } }));
}

/** Uploads files into a task's draft; each shows as a chip that fills in when it lands. */
export function addDraftFiles(taskId: string, files: File[]) {
  uploadWaiting(files, (change) => editDraft(taskId, (d) => ({ ...d, files: change(d.files) })));
}

interface NewComment {
  task: Task;
  body: string;
  /** The comment this replies to. */
  parentId?: string;
  files?: FileRow[];
  handTo?: string | null;
}

/** Posts a comment. It shows at once, with its files, and the task is handed on if asked. */
export function createComment({ task, body, parentId, files = [], handTo }: NewComment) {
  const me = getState().me;
  if (!me) return;
  const id = newId();
  const now = Date.now();
  const attached = commentFiles(files, id, task.id);
  const args: Changes["comment.create"] = { id, task: task.id, body };
  if (parentId) args.parent = parentId;
  if (attached.args) args.attachments = attached.args;
  if (handTo) args.waiting_on = handTo;

  send({ type: "comment.create", args }, (tx) => {
    tx.insert("comments", {
      id,
      task_id: task.id,
      subject_type: "task",
      subject_id: task.id,
      kind: "comment",
      parent_id: parentId,
      author_id: me.user_id,
      body,
      created_at: now,
    });
    attached.show(tx);
    if (handTo) tx.patch("tasks", task.id, { waiting_on_id: handTo, waiting_on_note: null });
  });
}

export function updateComment(comment: Comment, body: string) {
  send({ type: "comment.update", args: { id: comment.id, body } }, (tx) =>
    tx.patch("comments", comment.id, { body, edited_at: Date.now() }),
  );
}

export function deleteComment(comment: Comment) {
  send({ type: "comment.delete", args: { id: comment.id } }, (tx) =>
    tx.patch("comments", comment.id, { deleted_at: Date.now() }),
  );
}
