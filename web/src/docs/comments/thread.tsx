import { Check, LocateFixed, RotateCcw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useAttachmentsBySubject, useMember } from "@/data/selectors";
import { exact } from "@/lib/time";
import { addComment, deleteComment, resolveComment } from "@/docs/actions";
import { Composer } from "@/docs/comments/composer";
import type { ThreadData } from "@/docs/comments/threads";
import { pageUi } from "@/docs/page/state";
import type { Attached } from "@/types/core";
import type { DocComment } from "@/types/docs";
import { Avatar } from "@/ui/avatar";
import { IconButton } from "@/ui/button";
import { FileGrid } from "@/ui/file-grid";
import { Markdown } from "@/ui/markdown";
import { Ago } from "@/ui/ago";

interface Props {
  thread: ThreadData;
  docId: string;
  /** The page's project, to know whether the person may answer, resolve or delete. */
  projectId: string | undefined;
  /** What the thread is about, above it: its words, the block's text, the page. None beside its words. */
  quote?: ReactNode;
  /** The words or the block's text it is on, for its name; none for the page, or a block gone. */
  subject?: string;
  /** The thread asked for: its words were clicked, or its block's mark. */
  active: boolean;
  /** The pointer is on its words in the page. */
  lit?: boolean;
  /**
   * Only its first comment and its replies in short, with a way to open it:
   * a card in the margin that is not the one open.
   */
  compact?: boolean;
  /** Asks for the cursor in its reply box: each new number is an ask; 0 for none. */
  askReply?: number;
  /** Shows its words or its block in the page. */
  onLocate?: () => void;
  /** Opens it (a compact card): a click on it, or on its reply box. */
  onOpen?: () => void;
  /** Esc in it: it is no longer the one open. Without it, Esc in the reply box leaves the box. */
  onLeave?: () => void;
  /** It was resolved here, and leaves where it was shown: what takes the cursor it had. */
  onResolved?: () => void;
}

/** Words quoted in a thread's name, cut short. */
const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text);

/**
 * One comment thread: the first comment, its replies, each with its files,
 * a box to reply, and "resolve"; or, compact, the first comment and its
 * replies in short. The pointer on it lights its words in the page. Esc
 * never leaves the cursor nowhere: it goes to the thread, or to what opens
 * it again.
 */
export function Thread({
  thread,
  docId,
  projectId,
  quote,
  subject,
  active,
  lit,
  compact,
  askReply = 0,
  onLocate,
  onOpen,
  onLeave,
  onResolved,
}: Props) {
  const { root, replies } = thread;
  const done = !!root.resolved_at;
  const mayEdit = useCan().edit(projectId);
  const mayReply = !done && mayEdit;
  const author = useMember(root.author_id);
  const name = author?.name ?? t("common.someone");
  const files = useAttachmentsBySubject("comment");
  const card = useRef<HTMLElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  /** Esc closed the thread from inside it: the cursor goes to what opens it again once it is compact. */
  const refocus = useRef(false);

  useEffect(() => {
    // Not scrolled to: whoever asked has put the thread in view.
    if (askReply) box.current?.focus({ preventScroll: true });
  }, [askReply]);
  useEffect(() => {
    if (!compact || !refocus.current) return;
    refocus.current = false;
    (opener.current ?? card.current)?.focus({ preventScroll: true });
  }, [compact]);

  const onlyReply = replies.length === 1 ? replies[0] : undefined;
  const repliesLine = replies.length > 1 && (
    <button
      ref={mayReply ? undefined : opener}
      type="button"
      onClick={onOpen}
      className="mt-1.5 ml-7 text-xs font-medium text-ink-2 hover:text-ink hover:underline"
    >
      {t("docs.comment.replies", { n: replies.length })}
    </button>
  );

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a click on the thread is the mouse's way to open it or to its words; the keyboard has the thread's own buttons, and Esc in it is handled here for every control inside
    <article
      ref={card}
      tabIndex={-1}
      aria-label={
        subject ? t("docs.comment.label", { name, words: clip(subject) }) : t("docs.comment.labelBare", { name })
      }
      aria-current={active || undefined}
      data-thread={root.id}
      className={cx(
        "relative rounded-lg border bg-surface p-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "border-move" : lit ? "border-line-strong" : "border-line",
        (onOpen ?? onLocate) && "cursor-pointer hover:border-line-strong",
      )}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        // A click in a file shown over the screen comes through React from outside the thread.
        if (!card.current?.contains(target) || target.closest("button, a, textarea")) return;
        (onOpen ?? onLocate)?.();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if (onLeave) {
          e.preventDefault();
          e.stopPropagation();
          refocus.current = true;
          onLeave();
        } else if (e.target instanceof HTMLTextAreaElement) card.current?.focus({ preventScroll: true });
      }}
      onMouseEnter={() => pageUi.lightThread(root.id)}
      onMouseLeave={() => pageUi.lightThread(null)}
    >
      {!compact && (
        // Beside its words, with nothing quoted, the buttons sit in the corner instead of a row of their own.
        <div className={quote ? "flex items-start gap-1" : "absolute top-1.5 right-1.5 flex gap-1"}>
          {quote && <div className="min-w-0 flex-1">{quote}</div>}
          {onLocate && (
            <IconButton size="sm" label={t("docs.comment.locate")} onClick={onLocate}>
              <LocateFixed className="size-3.5" />
            </IconButton>
          )}
          {mayEdit && (
            <IconButton
              size="sm"
              label={t(done ? "docs.comment.reopen" : "docs.comment.resolve")}
              onClick={() => {
                resolveComment(root, !done);
                if (!done) onResolved?.();
              }}
            >
              {done ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
            </IconButton>
          )}
        </div>
      )}
      {compact ? (
        <>
          <div className="[&_.md]:line-clamp-4">
            <CommentBody comment={root} files={files[root.id]} projectId={projectId} />
          </div>
          {onlyReply && (
            <div className="[&_.md]:line-clamp-2">
              <CommentBody comment={onlyReply} files={files[onlyReply.id]} projectId={projectId} reply />
            </div>
          )}
          {repliesLine}
          {mayReply && (
            <button
              ref={opener}
              type="button"
              onClick={onOpen}
              className="mt-2 flex h-8 w-full items-center rounded-md border border-line px-2 text-left text-sm text-ink-3 hover:border-line-strong"
            >
              {t("docs.comment.reply")}
            </button>
          )}
        </>
      ) : (
        <>
          <div className={cx(!quote && (onLocate || mayEdit) && "pr-7")}>
            <CommentBody comment={root} files={files[root.id]} projectId={projectId} />
          </div>
          {replies.map((reply) => (
            <CommentBody key={reply.id} comment={reply} files={files[reply.id]} projectId={projectId} reply />
          ))}
          {mayReply && (
            <div className="mt-2">
              <Composer
                ref={box}
                placeholder={t("docs.comment.reply")}
                submitLabel={t("docs.comment.replySend")}
                onSubmit={(comment) => addComment({ docId, parentId: root.id, ...comment })}
              />
            </div>
          )}
        </>
      )}
    </article>
  );
}

function CommentBody({
  comment,
  files = [],
  projectId,
  reply,
}: {
  comment: DocComment;
  files?: Attached[];
  projectId: string | undefined;
  reply?: boolean;
}) {
  const author = useMember(comment.author_id);
  const can = useCan();
  return (
    <div className={cx("group/c flex gap-2", reply ? "mt-2 border-t border-line pt-2" : "mt-0.5")}>
      <Avatar member={author} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium">{author?.name ?? t("common.someone")}</span>
          <time className="shrink-0 text-xs text-ink-3" title={exact(comment.created_at)}>
            <Ago ms={comment.created_at} />
          </time>
          {can.editMadeBy(comment.author_id, projectId) && (
            <button
              type="button"
              aria-label={t("docs.comment.delete")}
              title={t("docs.comment.delete")}
              onClick={() => deleteComment(comment)}
              className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 hover:bg-hover hover:text-danger focus-visible:opacity-100 group-hover/c:opacity-100 max-md:opacity-100"
            >
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
        <Markdown text={comment.body} tight />
        <FileGrid files={files} small className="mt-1.5" />
      </div>
    </div>
  );
}
