import { memo } from "react";
import {
  Archive,
  AtSign,
  CircleCheck,
  CircleDot,
  ClipboardCheck,
  Hourglass,
  type LucideIcon,
  Mail,
  MailOpen,
  MessageCircleQuestion,
  MessageSquare,
  Reply,
  UserPlus,
} from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMember, useRowEvenIfGone } from "@/data/selectors";
import { exact } from "@/lib/time";
import type { Notification, NotificationType } from "@/types/core";
import { anchorOf, archive, markOpened, markRead, markUnread, splitTitle } from "@/pages/inbox-actions";
import { useTaskLink } from "@/nav/task-link";
import { Avatar } from "@/ui/avatar";
import { IconButton } from "@/ui/button";
import { DecisionMark } from "@/ui/icons";
import { Ago } from "@/ui/ago";

const icons: Record<NotificationType, LucideIcon | null> = {
  assigned: UserPlus,
  mentioned: AtSign,
  waiting_on: Hourglass,
  decision_asked: null, // drawn with the app's own question mark
  picked: CircleCheck,
  unclear: MessageCircleQuestion,
  replied: Reply,
  comment: MessageSquare,
  result: ClipboardCheck,
  status: CircleDot,
};

/** A snippet is the start of a Markdown text; shown on one line, its bold and code marks are only noise. */
const plain = (snippet: string) => snippet.replace(/(\*\*|~~|`)(.+?)\1/g, "$2");

interface Props {
  item: Notification;
  focused: boolean;
  onOpen: (item: Notification) => void;
  /** No marking read or archiving: the member may change nothing. */
  readOnly?: boolean;
}

/**
 * One inbox item: who did what, on which task, and the words that came with
 * it. Unread items carry the highlighter dot and stronger text.
 */
export const InboxRow = memo(function InboxRow({ item, focused, onOpen, readOnly }: Props) {
  const actor = useMember(item.actor_id);
  const unread = !item.read_at;
  const { key, title } = splitTitle(item.title);
  const Icon = icons[item.type] ?? MessageSquare;
  const who = actor ? `@${actor.handle}` : t("common.someone");
  // A type this version does not know yet reads as a plain comment.
  const sentence = t(item.type in icons ? (`inbox.type.${item.type}` as "inbox.type.comment") : "inbox.type.comment", {
    who,
  });
  const snippet = item.snippet ? plain(item.snippet) : "";
  // The row is a link to its task, so it opens in a new tab like any link; one about no task is a plain button.
  // A task in the trash too: its page shows it as trashed.
  const taskKey = useRowEvenIfGone("tasks", item.task_id)?.key ?? key;
  const link = useTaskLink({ key: taskKey ?? "" });
  const anchor = anchorOf(item);
  const to = anchor ? `${link.to}#${anchor}` : link.to;
  const what = (
    <>
      {key && <span className="shrink-0 text-xs text-ink-3 tnum">{key}</span>}
      <span className={cx("min-w-0 truncate", unread ? "font-medium text-ink" : "text-ink-2")}>{title}</span>
      {snippet && <span className="min-w-0 flex-1 basis-0 truncate text-ink-3 max-md:hidden">{snippet}</span>}
    </>
  );
  const whatStyle =
    "flex min-w-0 items-baseline gap-2 text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent max-md:mt-0.5 max-md:w-full md:flex-1";
  const label = `${sentence}. ${item.title ?? ""}`;

  return (
    <div
      data-focused={focused || undefined}
      className={cx(
        "group relative flex gap-2.5 border-b border-line/70 pr-2 pl-3 text-sm max-md:py-2 md:h-9 md:items-center",
        focused ? "bg-hover" : "bg-surface",
      )}
    >
      {focused && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      <span className="flex h-5 w-2 shrink-0 items-center justify-center">
        {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a picture drawn with CSS or SVG, not an image file */}
        {unread && <span className="size-2 rounded-full bg-move" role="img" aria-label={t("inbox.unread")} />}
      </span>
      <span className="flex h-5 shrink-0 items-center">
        <Avatar member={actor} size="sm" />
      </span>

      <div className="min-w-0 flex-1 md:flex md:items-center md:gap-3">
        <p className={cx("flex min-w-0 items-center gap-1.5 md:w-60 md:shrink-0", unread ? "text-ink" : "text-ink-2")}>
          {item.type === "decision_asked" ? (
            <DecisionMark mine={unread} />
          ) : (
            <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          )}
          <span className="truncate">{sentence}</span>
        </p>
        {taskKey ? (
          <Link
            {...link}
            to={to}
            onClick={() => unread && !readOnly && markOpened(item.id)}
            aria-label={label}
            // J and K move a marker, not the page's focus: the row's link says it is the one they are on.
            aria-current={focused || undefined}
            className={whatStyle}
          >
            {what}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(item)}
            aria-label={label}
            aria-current={focused || undefined}
            className={whatStyle}
          >
            {what}
          </button>
        )}
        {snippet && <p className="mt-0.5 truncate text-ink-3 md:hidden">{snippet}</p>}
      </div>

      <time
        dateTime={new Date(item.created_at).toISOString()}
        title={exact(item.created_at)}
        className="shrink-0 text-xs text-ink-3 tnum md:w-12 md:text-right"
      >
        <Ago ms={item.created_at} />
      </time>
      {!readOnly && (
        <div
          className={cx(
            "z-[1] flex items-center gap-0.5 bg-inherit",
            "max-md:absolute max-md:right-1 max-md:bottom-0.5",
            "md:absolute md:inset-y-0 md:right-2 md:pl-2 md:opacity-0 md:group-hover:opacity-100 md:group-data-[focused]:opacity-100 md:focus-within:opacity-100",
          )}
        >
          <IconButton
            label={unread ? t("inbox.markRead") : t("inbox.markUnread")}
            hint="U"
            size="sm"
            className="max-md:hidden"
            onClick={() => (unread ? markRead([item.id]) : markUnread([item.id]))}
          >
            {unread ? <MailOpen className="size-3.5" /> : <Mail className="size-3.5" />}
          </IconButton>
          <IconButton
            label={t("inbox.archive")}
            hint="E"
            size="sm"
            className="max-md:size-10"
            onClick={() => archive([item.id])}
          >
            <Archive className="size-3.5 max-md:size-4" />
          </IconButton>
        </div>
      )}
    </div>
  );
});
