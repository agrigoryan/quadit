// What can be done to inbox items. Each shows at once and is sent as the
// `notification.read` change (internal/engine/ch_inbox.go).

import { send } from "@/data/mutate";
import { getState } from "@/data/store";
import { t } from "@/lib/i18n";
import { type Batch, sendUndoable } from "@/data/undo";
import type { Notification } from "@/types/core";

/** "SVA-5 Jump feels floaty" as its key and its title; a title with no key stays whole. */
export function splitTitle(title: string | undefined): { key: string; title: string } {
  const m = /^([A-Z][A-Z0-9]*-\d+)\s+(.*)$/s.exec(title ?? "");
  return m ? { key: m[1] ?? "", title: m[2] ?? "" } : { key: "", title: title ?? "" };
}

/** The part of its task an item is about, as the task's address names it: a question asked opens at that question. */
export const anchorOf = (item: Notification): string | undefined =>
  item.entity_type === "decision" && item.entity_id ? `decision-${item.entity_id}` : undefined;

/** The batch that marks items read, or unread again. */
const reading = (ids: string[], read: boolean): Batch => ({
  changes: [{ type: "notification.read", args: read ? { ids } : { ids, unread: true } }],
  show: (tx) => {
    for (const id of ids) tx.patch("notifications", id, { read_at: read ? Date.now() : null });
  },
});

/** Marks items read or unread; undone, the ones it changed go back. */
function setRead(ids: string[], read: boolean) {
  const { notifications } = getState().collections;
  const changed = ids.filter((id) => notifications[id] && !!notifications[id].read_at !== read);
  if (changed.length === 0) return;
  const name = t(read ? "undo.read" : "undo.unread", { n: changed.length });
  sendUndoable(name, reading(changed, read), reading(changed, !read));
}

/** An item opened is read: that follows from opening it, and is not a step of its own to undo. */
export function markOpened(id: string) {
  const batch = reading([id], true);
  send(batch.changes, batch.show);
}

export const markRead = (ids: string[]) => setRead(ids, true);
export const markUnread = (ids: string[]) => setRead(ids, false);

/** Takes items out of the inbox. Undone, they are back in it, unread if they were. */
export function archive(ids: string[]) {
  const { notifications } = getState().collections;
  const unread = ids.filter((id) => notifications[id] && !notifications[id].read_at);
  const back: Batch = {
    changes: [{ type: "notification.read", args: { ids, unarchive: true } }],
    show: (tx) => {
      for (const id of ids) tx.patch("notifications", id, { archived_at: null });
      for (const id of unread) tx.patch("notifications", id, { read_at: null });
    },
  };
  // Taking an item out marks it read: one that was unread is made so again.
  if (unread.length > 0) back.changes.push({ type: "notification.read", args: { ids: unread, unread: true } });
  sendUndoable(
    t("undo.archive", { n: ids.length }),
    {
      changes: [{ type: "notification.read", args: { ids, archive: true } }],
      show: (tx) => {
        const now = Date.now();
        for (const id of ids) tx.patch("notifications", id, { archived_at: now, read_at: now });
      },
    },
    back,
  );
}

/** Takes the read items of those shown out of the inbox, in one step to undo; the unread stay. */
export function archiveRead(shown: Notification[]) {
  const ids = shown.filter((n) => n.read_at).map((n) => n.id);
  if (ids.length > 0) archive(ids);
}

/** Marks everything shown as read; items that arrive after the newest one shown stay unread. */
export function markAllRead(shown: Notification[]) {
  const unread = shown.filter((n) => !n.read_at);
  if (unread.length === 0) return;
  const now = Date.now();
  const upTo = Math.max(...shown.map((n) => n.seq));
  const ids = unread.map((n) => n.id);
  sendUndoable(
    t("undo.read", { n: ids.length }),
    {
      changes: [{ type: "notification.read", args: { all: true, up_to: upTo } }],
      show: (tx) => {
        for (const id of ids) tx.patch("notifications", id, { read_at: now });
      },
    },
    reading(ids, false),
  );
}
