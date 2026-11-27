// Files given with a comment, on a task or on a page: each is uploaded while
// the comment is written, listed meanwhile as waiting, and sent with the
// comment, which shows them at once (ui/comment-files.tsx draws the list).

import type { Changes } from "@/types/changes.gen";
import type { FileRow } from "@/types/core";
import { uploadOrToast } from "@/data/files";
import type { Tx } from "@/data/mutate";
import { getState } from "@/data/store";
import { newId } from "@/lib/ids";

/** A file given with a comment that is being written. */
export interface WaitingFile {
  key: string;
  name: string;
  /** Missing while the file is still uploading. */
  file?: FileRow;
}

/** Changes the list of files waiting, wherever the comment's draft keeps it. */
export type EditWaiting = (change: (files: WaitingFile[]) => WaitingFile[]) => void;

/**
 * Adds files to a comment's list and uploads them. Each fills in when it
 * lands; one that fails is taken off the list, and a toast says why.
 */
export function uploadWaiting(files: File[], edit: EditWaiting) {
  for (const file of files) {
    const key = newId();
    edit((list) => [...list, { key, name: file.name }]);
    void uploadOrToast(file).then((row) =>
      edit((list) =>
        row ? list.map((f) => (f.key === key ? { ...f, file: row } : f)) : list.filter((f) => f.key !== key),
      ),
    );
  }
}

/** What of a list can be sent: the files uploaded, and whether some are still on their way. */
export function readyFiles(list: WaitingFile[]): { files: FileRow[]; uploading: boolean } {
  return { files: list.flatMap((f) => (f.file ? [f.file] : [])), uploading: list.some((f) => !f.file) };
}

/**
 * The files of a new comment as `comment.create` takes them (none: left
 * out), and what shows them on the comment before the server answers.
 * `taskId` is the task the comment is on; a page's comment has none.
 */
export function commentFiles(
  files: FileRow[],
  commentId: string,
  taskId?: string,
): { args: Changes["comment.create"]["attachments"]; show: (tx: Tx) => void } {
  const attachments = files.map((file) => ({ id: newId(), file }));
  return {
    args: attachments.length ? attachments.map((a) => ({ id: a.id, file: a.file.id })) : undefined,
    show(tx) {
      const now = Date.now();
      attachments.forEach((a, i) =>
        tx.insert("attachments", {
          id: a.id,
          file_id: a.file.id,
          subject_type: "comment",
          subject_id: commentId,
          task_id: taskId,
          rank: String(i).padStart(4, "0") + "1",
          created_by: getState().me?.user_id,
          created_at: now,
          file: a.file,
        }),
      );
    },
  };
}
