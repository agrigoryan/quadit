import { Check, LocateFixed, RotateCcw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useAttachmentsBySubject, useMember } from "@/data/selectors";
import { exact } from "@/lib/time";
import { addComment, deleteComment, resolveComment } from "@/docs/actions";
import { Composer } from "@/docs/comments/composer";
import type { ThreadData } from "@/docs/comments/panel";
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
  /** What the thread is about: its words, the block's text, the page. */
  quote: ReactNode;
  /** The thread asked for: its words were clicked, or its block's mark. */
  active: boolean;
  /** The pointer is on its words in the page. */
  lit?: boolean;
  /** Shows its words or its block in the page. */
  onLocate?: () => void;
}

/**
 * One comment thread: the first comment, its replies, each with its files,
 * a box to reply, and "resolve". The pointer on it lights its words in the page; asked for, it
 * comes into view.
 */
export function Thread({ thread, docId, projectId, quote, active, lit, onLocate }: Props) {
  const { root, replies } = thread;
  const done = !!root.resolved_at;
  const readOnly = !useCan().edit(projectId);
  const files = useAttachmentsBySubject("comment");
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) card.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a click on the thread is the mouse's way to its words or block; the keyboard has the thread's own button
    <article
      ref={card}
      aria-current={active || undefined}
      data-thread={root.id}
      className={cx(
        "rounded-lg border bg-surface p-2 transition-colors",
        active ? "border-move" : lit ? "border-line-strong" : "border-line",
        onLocate && "cursor-pointer hover:border-line-strong",
      )}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        // A click in a file shown over the screen comes through React from outside the thread.
        if (card.current?.contains(target) && !target.closest("button, a, textarea")) onLocate?.();
      }}
      onMouseEnter={() => pageUi.lightThread(root.id)}
      onMouseLeave={() => pageUi.lightThread(null)}
    >
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">{quote}</div>
        {onLocate && (
          <IconButton size="sm" label={t("docs.comment.locate")} onClick={onLocate}>
            <LocateFixed className="size-3.5" />
          </IconButton>
        )}
        {!readOnly && (
          <IconButton
            size="sm"
            label={t(done ? "docs.comment.reopen" : "docs.comment.resolve")}
            onClick={() => resolveComment(root, !done)}
          >
            {done ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          </IconButton>
        )}
      </div>
      <CommentBody comment={root} files={files[root.id]} projectId={projectId} />
      {replies.map((reply) => (
        <CommentBody key={reply.id} comment={reply} files={files[reply.id]} projectId={projectId} reply />
      ))}
      {!done && !readOnly && (
        <div className="mt-2">
          <Composer
            placeholder={t("docs.comment.reply")}
            submitLabel={t("docs.comment.replySend")}
            onSubmit={(comment) => addComment({ docId, parentId: root.id, ...comment })}
          />
        </div>
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
