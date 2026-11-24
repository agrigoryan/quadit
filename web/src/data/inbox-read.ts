// An inbox item is read once what it is about has been looked at: opening a
// task, or a page, and staying on it a moment marks the unread items about
// it read. Quietly: it follows from looking, and is not a step to undo.

import { useEffect } from "react";
import { useCan } from "@/data/access";
import { send, type Tx } from "@/data/mutate";
import { getState } from "@/data/store";

/** How long a task or page stays open before its items count as seen: flipping through a list reads nothing. */
export const SEEN_AFTER_MS = 1000;

/** What was opened: a task or a page, by id. */
type Opened = { taskId?: string; docId?: string };

/**
 * Marks my unread inbox items about what is open read, once it has been
 * open for a moment: those there are by then, not ones that come later. A
 * member who may change nothing marks nothing.
 */
export function useReadWhenSeen({ taskId, docId }: Opened) {
  const { write } = useCan();
  useEffect(() => {
    if (!write || (!taskId && !docId)) return;
    const timer = setTimeout(() => readItemsAbout({ taskId, docId }), SEEN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [write, taskId, docId]);
}

/** Marks my unread items about a task (up to the newest there is now) or a page read, showing it at once. */
export function readItemsAbout({ taskId, docId }: Opened) {
  const { collections, me } = getState();
  const unread = Object.values(collections.notifications).filter(
    (n) =>
      n.user_id === me?.user_id &&
      !n.read_at &&
      !n.archived_at &&
      (taskId ? n.task_id === taskId : !!docId && n.doc_id === docId),
  );
  if (unread.length === 0) return;
  const now = Date.now();
  const show = (tx: Tx) => {
    for (const n of unread) tx.patch("notifications", n.id, { read_at: now });
  };
  // A task's items are named by the task, up to the newest seen; a page's by their ids (the change names no page).
  if (taskId)
    send({ type: "notification.read", args: { task: taskId, up_to: Math.max(...unread.map((n) => n.seq)) } }, show);
  else send({ type: "notification.read", args: { ids: unread.map((n) => n.id) } }, show);
}
