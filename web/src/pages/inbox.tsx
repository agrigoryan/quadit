import { useCallback, useMemo, useRef } from "react";
import { CheckCheck, Inbox } from "lucide-react";
import { t } from "@/lib/i18n";
import { useCollection, useMe } from "@/lib/selectors";
import { getState } from "@/lib/store";
import type { Notification } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { anchorOf, archive, markAllRead, markRead, markUnread, splitTitle } from "@/pages/inbox-actions";
import { InboxRow } from "@/pages/inbox-row";
import { type OpenAs, useListKeys } from "@/tasks/list-keys";
import { useTaskNav } from "@/lib/task-link";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

/** The task an item is about: by the task itself, or by the key its title starts with. */
const taskKeyOf = (item: Notification) =>
  (item.task_id && getState().collections.tasks[item.task_id]?.key) || splitTitle(item.title).key || undefined;

const toggleRead = (item: Notification) => (item.read_at ? markUnread([item.id]) : markRead([item.id]));

/** The inbox: everything that was sent to me, newest first, until I archive it. */
export function InboxPage() {
  usePageTitle(t("nav.inbox"));
  const me = useMe();
  const notifications = useCollection("notifications");
  const tasks = useTaskNav();
  const scroller = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () =>
      Object.values(notifications)
        .filter((n) => !n.archived_at && n.user_id === me.user_id)
        .sort((a, b) => b.seq - a.seq),
    [notifications, me.user_id],
  );
  const unread = useMemo(() => items.filter((n) => !n.read_at).length, [items]);

  const open = useCallback(
    (item: Notification, as: OpenAs = "peek") => {
      if (!item.read_at) markRead([item.id]);
      const key = taskKeyOf(item);
      if (key) tasks[as](key, anchorOf(item));
    },
    [tasks],
  );

  const focusId = useListKeys({
    rows: items,
    idOf: (item) => item.id,
    onOpen: open,
    taskKeyOf,
    scroller,
    keys: { e: (item) => archive([item.id]), u: toggleRead },
  });

  if (items.length === 0) {
    return <EmptyState icon={<Inbox />} title={t("inbox.empty")} hint={t("inbox.emptyHint")} />;
  }

  return (
    <div ref={scroller} className="h-full overflow-y-auto pb-10">
      <header className="sticky top-0 z-[2] flex h-10 items-center gap-2 border-b border-line bg-surface pr-2 pl-4">
        <p className="flex-1 text-xs text-ink-2 tnum" aria-live="polite">
          {unread > 0 ? t("nav.unread", { n: unread }) : t("inbox.allRead")}
        </p>
        <Button variant="ghost" disabled={unread === 0} onClick={() => markAllRead(items)} className="max-sm:h-9">
          <CheckCheck className="size-4" aria-hidden />
          {t("inbox.markAllRead")}
        </Button>
      </header>
      {items.map((item) => (
        <InboxRow key={item.id} item={item} focused={focusId === item.id} onOpen={open} />
      ))}
    </div>
  );
}
