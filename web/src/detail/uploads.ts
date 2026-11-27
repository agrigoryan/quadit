// Putting files on a task: each one is uploaded, then attached with an
// `attachment.add` change. While a file is on its way it is listed here so
// the panel can show it as "uploading".

import { create } from "zustand";
import { uploadOrToast } from "@/data/files";
import { newId } from "@/lib/ids";
import { send } from "@/data/mutate";
import { rankBetween } from "@/lib/rank";
import { getRows } from "@/data/selectors";
import { getState } from "@/data/store";
import type { Task } from "@/types/core";
import type { PendingUpload } from "@/ui/file-grid";

/** Files still uploading, by the task they will be attached to. */
export const useUploads = create<{ pending: Record<string, PendingUpload[]> }>(() => ({ pending: {} }));

function setPending(taskId: string, change: (list: PendingUpload[]) => PendingUpload[]) {
  useUploads.setState((s) => ({ pending: { ...s.pending, [taskId]: change(s.pending[taskId] ?? []) } }));
}

async function attachOne(task: Task, file: File) {
  const pending: PendingUpload = { id: newId(), name: file.name };
  setPending(task.id, (list) => [...list, pending]);
  // Each new try starts by saying "sending"; the tile keeps saying it waits until bytes really move again.
  let waiting = false;
  let reached = 0;
  const row = await uploadOrToast(file, {
    onProgress: (p) => {
      if (p.state === "waiting") waiting = true;
      else if (p.sent > reached) waiting = false;
      reached = Math.max(reached, p.sent);
      const percent = p.total > 0 ? Math.min(100, Math.floor((p.sent / p.total) * 100)) : 0;
      const now = waiting;
      setPending(task.id, (list) =>
        list.map((it) =>
          it.id === pending.id && (it.percent !== percent || it.waiting !== now)
            ? { ...it, percent, waiting: now }
            : it,
        ),
      );
    },
  });
  if (row) {
    const { me } = getState();
    let last = "";
    for (const a of getRows("attachments")) {
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
