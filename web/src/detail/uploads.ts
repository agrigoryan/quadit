// Putting files on a task: each one is uploaded, then attached with an
// `attachment.add` change. While a file is on its way it is listed here so
// the panel can show it as "uploading".

import { create } from "zustand";
import { errorMessage } from "@/lib/api";
import { uploadFile } from "@/lib/files";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { send } from "@/lib/mutate";
import { rankBetween } from "@/lib/rank";
import { getState } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Task } from "@/lib/types";

export interface PendingUpload {
  id: string;
  name: string;
}

/** Files still uploading, by the task they will be attached to. */
export const useUploads = create<{ pending: Record<string, PendingUpload[]> }>(() => ({ pending: {} }));

function setPending(taskId: string, change: (list: PendingUpload[]) => PendingUpload[]) {
  useUploads.setState((s) => ({ pending: { ...s.pending, [taskId]: change(s.pending[taskId] ?? []) } }));
}

/** Uploads one file, saying so if it fails. Resolves with nothing when it did. */
export async function uploadOrToast(file: File) {
  try {
    return await uploadFile(file);
  } catch (err) {
    toast.error(t("detail.files.failed", { name: file.name, reason: errorMessage(err) }));
    return undefined;
  }
}

async function attachOne(task: Task, file: File) {
  const pending: PendingUpload = { id: newId(), name: file.name };
  setPending(task.id, (list) => [...list, pending]);
  const row = await uploadOrToast(file);
  if (row) {
    const { c, me } = getState();
    let last = "";
    for (const a of Object.values(c.attachments)) {
      if (a.subject_type === "task" && a.subject_id === task.id && a.rank > last) last = a.rank;
    }
    const id = newId();
    send({ type: "attachment.add", args: { id, file: row.id, task: task.id } }, (tx) =>
      tx.insert("attachments", {
        id,
        file_id: row.id,
        subject_type: "task",
        subject_id: task.id,
        task_id: task.id,
        rank: rankBetween(last || undefined, undefined),
        created_by: me?.user_id,
        created_at: Date.now(),
        file: row,
      }),
    );
  }
  setPending(task.id, (list) => list.filter((p) => p.id !== pending.id));
}

/** Attaches files to the task itself, several at once. */
export function attachToTask(task: Task, files: File[]) {
  for (const file of files) void attachOne(task, file);
}

export function removeAttachment(id: string) {
  send({ type: "attachment.remove", args: { id } }, (tx) => tx.patch("attachments", id, { deleted_at: Date.now() }));
}

/** True when a drag carries files (and not text or a link from the page). */
export const carriesFiles = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer?.types.includes("Files");
