// An inbox item is read once what it is about has been looked at: a task,
// or a page, loaded and shown for a moment marks the unread items about it
// read. Quietly: it follows from looking, is not a step to undo, and when
// the server refuses it (a task in the trash) nothing is said and nothing
// changes on screen; the feed brings the items read when it is accepted.

import { useEffect } from "react";
import { useCan } from "@/data/access";
import { mutate } from "@/data/mutate";
import { getState } from "@/data/store";
import type { Notification } from "@/types/core";

/** How long a task or page stays shown before its items count as seen: flipping through a list reads nothing. */
export const SEEN_AFTER_MS = 1000;

/** What was opened: a task or a page, by id; `ready` once it has loaded, without error, and can be read. */
type Opened = { taskId?: string; docId?: string; ready: boolean };

/**
 * Marks my unread inbox items about what is open read once it has been
 * loaded and shown for a moment: a task opened in a background tab waits
 * until it is looked at, and the moment starts over each time the page is
 * shown again. Those unread when the moment began, not ones that came
 * during it. A member who may change nothing marks nothing.
 */
export function useReadWhenSeen({ taskId, docId, ready }: Opened) {
  const { write } = useCan();
  useEffect(() => {
    if (!write || !ready || (!taskId && !docId)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const count = () => {
      clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      const unread = unreadAbout(taskId, docId);
      if (unread.length > 0) timer = setTimeout(() => read(unread, taskId), SEEN_AFTER_MS);
    };
    count();
    document.addEventListener("visibilitychange", count);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", count);
    };
  }, [write, ready, taskId, docId]);
}

/** My unread, live items about a task or a page. */
function unreadAbout(taskId: string | undefined, docId: string | undefined): Notification[] {
  const { collections, me } = getState();
  return Object.values(collections.notifications).filter(
    (n) =>
      n.user_id === me?.user_id &&
      !n.read_at &&
      !n.archived_at &&
      (taskId ? n.task_id === taskId : !!docId && n.doc_id === docId),
  );
}

/**
 * Marks the items read: a task's by the task, up to the newest of them; a
 * page's by their ids (the change names no page). Nothing is shown ahead of
 * the server and nothing is said if it refuses.
 */
function read(items: Notification[], taskId: string | undefined) {
  const args = taskId ? { task: taskId, up_to: Math.max(...items.map((n) => n.seq)) } : { ids: items.map((n) => n.id) };
  // A refusal is nobody's to hear about: the person only looked.
  mutate({ type: "notification.read", args }, undefined, { quiet: true }).catch(() => {});
}
