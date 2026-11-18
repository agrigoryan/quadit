// What the person's computer is told about the open workspace, outside the
// page: the unread count on the app's icon, and in the Quadit desktop app a
// notification for each new inbox item.
//
// A browser gets its notifications by push (public/sw.js, sent by the
// server). The desktop app has no push: its pages are given a bridge
// instead (types/desktop.ts), and the notifications come from the live
// stream, from the one window that reads it (data/sync.ts); the app shows
// each item once whichever window tells it. The words are push's own
// (jobNotify, internal/server/jobs.go): the server's headline of the item
// (core.NoteHeadlines, generated into i18n/en/push.gen.ts), with its
// snippet below.

import { useEffect } from "react";
import { useSession } from "@/auth/session";
import { getRowEvenIfGone, useUnreadCount, useWorkspaceId } from "@/data/selectors";
import { getState } from "@/data/store";
import { onStreamEvents } from "@/data/sync";
import { docPath } from "@/docs/area";
import { isKey, t } from "@/lib/i18n";
import { taskPath } from "@/nav/task-link";
import { anchorOf, splitTitle } from "@/pages/inbox-actions";
import type { Notification } from "@/types/core";
import type { QuaditDesktop } from "@/types/desktop";

/** Keeps the computer told about the workspace open in the shell, for as long as the shell is on screen. */
export function useSystemNotices() {
  const unread = useUnreadCount();
  // The app adds up the workspaces of a server, each once however many of its windows report it.
  const workspace = useWorkspaceId();

  useEffect(() => {
    const desktop = window.quaditDesktop;
    desktop?.setBadge(unread, workspace);
    // Where a browser has no badge, or keeps it to installed apps, there is nothing to set.
    if ("setAppBadge" in navigator) void navigator.setAppBadge(unread).catch(() => {});
  }, [unread, workspace]);

  // Leaving the workspace, or signing out, takes this window's count off the icon.
  useEffect(() => {
    const desktop = window.quaditDesktop;
    return () => {
      desktop?.setBadge(0, workspace);
      if ("clearAppBadge" in navigator) void navigator.clearAppBadge().catch(() => {});
    };
  }, [workspace]);

  useEffect(() => {
    const desktop = window.quaditDesktop;
    if (!desktop) return;
    return onStreamEvents((events) => {
      // "Send push notifications" off in the person's settings means nothing is shown outside the app.
      if (useSession.getState().user?.notify?.push === false) return;
      const me = getState().me?.user_id;
      for (const ev of events) {
        if (ev.type !== "notification.created") continue;
        const item = ev.data.row as Notification | undefined;
        if (item && item.user_id === me && !item.read_at) desktop.notify(noticeOf(item));
      }
    });
  }, []);
}

/** What the desktop app shows for an inbox item, and the address a click opens: its task, the page it is about, or the inbox. */
function noticeOf(item: Notification): Parameters<QuaditDesktop["notify"]>[0] {
  const { slug } = getState();
  // Named even when gone, as push names them: the actor who left, the task in the trash. Nobody known, no name.
  const who = getRowEvenIfGone("members", item.actor_id)?.name ?? "";
  const key = getRowEvenIfGone("tasks", item.task_id)?.key || splitTitle(item.title).key;
  const anchor = anchorOf(item);
  let path = `/${slug}/inbox`;
  if (key) path = taskPath(slug, key) + (anchor ? `#${anchor}` : "");
  else if (item.doc_id) path = docPath(slug, item.doc_id);
  // A type this version does not know yet reads as a comment, as on the server.
  const headline = `push.${item.type}`;
  return {
    title: t(isKey(headline) ? headline : "push.comment", { who, title: item.title ?? "" }).trim(),
    body: item.snippet ?? "",
    path,
    // The same task or page replaces its earlier notification, as push does.
    tag: (item.task_id ?? "") + (item.doc_id ?? "") || undefined,
    // The app shows an item once, however many of its windows hear it.
    id: item.id,
  };
}
