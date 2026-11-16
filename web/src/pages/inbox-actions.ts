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

/** Takes items out of the inbox for good: the one thing here Cmd+Z does not bring back. */
export function archive(ids: string[]) {
  const now = Date.now();
  send({ type: "notification.read", args: { ids, archive: true } }, (tx) => {
    for (const id of ids) tx.patch("notifications", id, { archived_at: now, read_at: now });
  });
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
