// The inbox: what was sent to me, newest first, until I archive it, in two
// tabs. "Needs you" holds what was meant for me (I was asked, assigned,
// handed, mentioned, replied to, told, or the task is mine: the item's
// `addressed`); "Updates" what I only hear of as a follower. Each tab is a
// list of its own: its keys, its counts and its "Mark all read".

import { useCallback, useMemo, useRef, useState } from "react";
import { Archive, CheckCheck, Inbox } from "lucide-react";
import { Tabs } from "radix-ui";
import { cx } from "@/lib/cx";
import { formatNumber, t } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { getRow, getRowEvenIfGone, needsYou, useMe, useRows } from "@/data/selectors";
import type { Notification } from "@/types/core";
import { usePageTitle } from "@/lib/ui-state";
import {
  anchorOf,
  archive,
  archiveRead,
  markAllRead,
  markOpened,
  markRead,
  markUnread,
  splitTitle,
} from "@/pages/inbox-actions";
import { InboxRow } from "@/pages/inbox-row";
import { type OpenAs, useListKeys } from "@/tasks/list-keys";
import { useTaskKeys } from "@/tasks/task-keys";
import { useTaskNav } from "@/nav/task-link";
import { useHotkeys } from "@/hooks/hotkeys";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

/** The task an item is about: by the task itself (in the trash too: its page shows it), or by the key its title starts with. */
const taskKeyOf = (item: Notification) =>
  (item.task_id && getRowEvenIfGone("tasks", item.task_id)?.key) || splitTitle(item.title).key || undefined;

const toggleRead = (item: Notification) => (item.read_at ? markUnread([item.id]) : markRead([item.id]));

type Tab = "needs" | "updates";

/** Where the last tab shown is kept, for this tab of the browser only. */
const TAB_KEY = "quadit.inbox.tab";

function keptTab(): Tab {
  try {
    return sessionStorage.getItem(TAB_KEY) === "updates" ? "updates" : "needs";
  } catch {
    return "needs";
  }
}

function keepTab(tab: Tab) {
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {
    // Not kept: the inbox opens on Needs you next time, which is where it starts anyway.
  }
}

/** The inbox: everything that was sent to me, newest first, until I archive it, in its two tabs. */
export function InboxPage() {
  usePageTitle(t("nav.inbox"));
  const me = useMe();
  // Live notifications: an archived one is gone from the inbox.
  const notifications = useRows("notifications");
  // Marking read and archiving are changes (notification.read): a read-only member may make none.
  const { write } = useCan();
  const tasks = useTaskNav();
  const scroller = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<Tab>(keptTab);
  const choose = (next: Tab) => {
    setTab(next);
    keepTab(next);
  };
  const all = useMemo(
    () => notifications.filter((n) => n.user_id === me.user_id).sort((a, b) => b.seq - a.seq),
    [notifications, me.user_id],
  );
  const lists = useMemo(() => ({ needs: all.filter(needsYou), updates: all.filter((n) => !needsYou(n)) }), [all]);
  const unreadOf = (list: Notification[]) => list.filter((n) => !n.read_at).length;
  const counts = { needs: unreadOf(lists.needs), updates: unreadOf(lists.updates) };
  const items = lists[tab];
  const unread = counts[tab];
  const read = items.length - unread;

  const open = useCallback(
    (item: Notification, as: OpenAs = "peek") => {
      if (write && !item.read_at) markOpened(item.id);
      const key = taskKeyOf(item);
      if (key) tasks[as](key, anchorOf(item));
    },
    [tasks, write],
  );

  const focusId = useListKeys({
    rows: items,
    idOf: (item) => item.id,
    onOpen: open,
    taskKeyOf,
    scroller,
    keys: write ? { e: (item) => archive([item.id]), Backspace: (item) => archive([item.id]), u: toggleRead } : {},
  });
  // What acts on the whole inbox: Shift+Backspace takes every read item out, Option+U marks everything read (as in Linear).
  useHotkeys(
    {
      "shift+Backspace": (e) => {
        e.preventDefault();
        archiveRead(items);
      },
      "alt+u": (e) => {
        e.preventDefault();
        markAllRead(items, tab === "needs");
      },
    },
    { enabled: write },
  );
  // S/A/P/L, I, the copy keys and Cmd+Backspace act on the task the focused item is about.
  const picker = useTaskKeys({
    tasksFor: () => {
      const item = items.find((n) => n.id === focusId);
      const task = getRow("tasks", item?.task_id);
      return task ? [task] : [];
    },
    anchorFor: () => scroller.current?.querySelector("[data-focused]") ?? scroller.current,
  });

  if (all.length === 0) {
    return <EmptyState icon={<Inbox />} title={t("inbox.empty")} hint={t("inbox.emptyHint")} />;
  }

  return (
    <Tabs.Root value={tab} onValueChange={(next) => choose(next as Tab)} asChild>
      <div ref={scroller} className="h-full overflow-y-auto pb-10">
        <header className="sticky top-0 z-[2] flex h-10 items-center gap-2 border-b border-line bg-surface pr-2 pl-2">
          <Tabs.List aria-label={t("inbox.tabs")} className="flex h-full items-stretch">
            {(["needs", "updates"] as const).map((id) => (
              <Tabs.Trigger
                key={id}
                value={id}
                className={cx(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium outline-none focus-visible:bg-hover",
                  tab === id ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink",
                )}
              >
                {t(`inbox.tab.${id}`)}
                {counts[id] > 0 && (
                  <span
                    className={cx(
                      "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-2xs font-semibold tnum",
                      id === "needs" ? "bg-move text-move-ink" : "bg-sunken text-ink-2",
                    )}
                  >
                    {formatNumber(counts[id])}
                  </span>
                )}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <p className="flex-1 pl-2 text-xs text-ink-2 tnum max-sm:hidden" aria-live="polite">
            {/* An empty tab says so below; "everything is read" there would read as the whole inbox. */}
            {unread > 0 ? t("nav.unread", { n: unread }) : items.length > 0 && t("inbox.allRead")}
          </p>
          <Button
            variant="ghost"
            disabled={!write || unread === 0}
            onClick={() => markAllRead(items, tab === "needs")}
            className="max-sm:ml-auto max-sm:h-9"
          >
            <CheckCheck className="size-4" aria-hidden />
            {t("inbox.markAllRead")}
          </Button>
          <Button
            variant="ghost"
            disabled={!write || read === 0}
            onClick={() => archiveRead(items)}
            className="max-sm:h-9"
          >
            <Archive className="size-4" aria-hidden />
            {t("inbox.archiveRead")}
          </Button>
        </header>
        <Tabs.Content value={tab} className="outline-none">
          {items.length === 0 ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-6 text-sm text-ink-2">
              {tab === "needs" ? t("inbox.needsNone") : t("inbox.updatesNone")}
              {tab === "needs" && counts.updates > 0 && (
                <button
                  type="button"
                  onClick={() => choose("updates")}
                  className="font-medium text-accent-text underline-offset-2 hover:underline"
                >
                  {t("inbox.showUpdates", { n: counts.updates })}
                </button>
              )}
            </p>
          ) : (
            items.map((item) => (
              <InboxRow key={item.id} item={item} focused={focusId === item.id} onOpen={open} readOnly={!write} />
            ))
          )}
        </Tabs.Content>
        {picker}
      </div>
    </Tabs.Root>
  );
}
