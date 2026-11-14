// Writing comments: the unsent draft of each task's comment box (kept while
// the app is open, so moving between tasks loses nothing), and the changes
// that post, edit and delete a comment.

import { create } from "zustand";
import { newId } from "@/lib/ids";
import { send } from "@/lib/mutate";
import { getState } from "@/lib/store";
import type { Comment, FileRow, Task } from "@/lib/types";
import { uploadOrToast } from "@/detail/uploads";

export interface DraftFile {
  key: string;
  name: string;
  /** Missing while the file is still uploading. */
  file?: FileRow;
}

export interface Draft {
  body: string;
  files: DraftFile[];
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
  for (const file of files) {
    const key = newId();
    editDraft(taskId, (d) => ({ ...d, files: [...d.files, { key, name: file.name }] }));
    void uploadOrToast(file).then((row) =>
      editDraft(taskId, (d) => ({
        ...d,
        files: row ? d.files.map((f) => (f.key === key ? { ...f, file: row } : f)) : d.files.filter((f) => f.key !== key),
      })),
    );
  }
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
  const attachments = files.map((file) => ({ id: newId(), file }));
  const args: Record<string, unknown> = { id, task: task.id, body };
  if (parentId) args.parent = parentId;
  if (attachments.length) args.attachments = attachments.map((a) => ({ id: a.id, file: a.file.id }));
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
    attachments.forEach((a, i) =>
      tx.insert("attachments", {
        id: a.id,
        file_id: a.file.id,
        subject_type: "comment",
        subject_id: id,
        task_id: task.id,
        rank: String(i).padStart(4, "0") + "1",
        created_by: me.user_id,
        created_at: now,
        file: a.file,
      }),
    );
    if (handTo) tx.patch("tasks", task.id, { waiting_on_id: handTo, waiting_on_note: null });
  });
}

export function updateComment(comment: Comment, body: string) {
  send({ type: "comment.update", args: { id: comment.id, body } }, (tx) => tx.patch("comments", comment.id, { body, edited_at: Date.now() }));
}

export function deleteComment(comment: Comment) {
  send({ type: "comment.delete", args: { id: comment.id } }, (tx) => tx.patch("comments", comment.id, { deleted_at: Date.now() }));
}
