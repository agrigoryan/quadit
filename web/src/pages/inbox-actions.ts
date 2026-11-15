// What can be done to inbox items. Each shows at once and is sent as the
// `notification.read` change (internal/engine/ch_inbox.go).

import { send } from "@/lib/mutate";
import type { Notification } from "@/lib/types";

/** "SVA-5 Jump feels floaty" as its key and its title; a title with no key stays whole. */
export function splitTitle(title: string | undefined): { key: string; title: string } {
  const m = /^([A-Z][A-Z0-9]*-\d+)\s+(.*)$/s.exec(title ?? "");
  return m ? { key: m[1] ?? "", title: m[2] ?? "" } : { key: "", title: title ?? "" };
}

/** The part of its task an item is about, as the task's address names it: a question asked opens at that question. */
export const anchorOf = (item: Notification): string | undefined =>
  item.entity_type === "decision" && item.entity_id ? `decision-${item.entity_id}` : undefined;

export function markRead(ids: string[]) {
  const now = Date.now();
  send({ type: "notification.read", args: { ids } }, (tx) => {
    for (const id of ids) tx.patch("notifications", id, { read_at: now });
  });
}

export function markUnread(ids: string[]) {
  send({ type: "notification.read", args: { ids, unread: true } }, (tx) => {
    for (const id of ids) tx.patch("notifications", id, { read_at: null });
  });
}

/** Takes items out of the inbox for good. */
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
  send({ type: "notification.read", args: { all: true, up_to: upTo } }, (tx) => {
    for (const n of unread) tx.patch("notifications", n.id, { read_at: now });
  });
}
