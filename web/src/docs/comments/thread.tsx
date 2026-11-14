import { Check, RotateCcw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMe, useMember } from "@/lib/selectors";
import { exact } from "@/lib/time";
import { addComment, deleteComment, resolveComment } from "@/docs/actions";
import { Composer } from "@/docs/comments/composer";
import type { ThreadData } from "@/docs/comments/panel";
import type { DocComment } from "@/docs/types";
import { Avatar } from "@/ui/avatar";
import { IconButton } from "@/ui/button";
import { Markdown } from "@/ui/markdown";
import { Ago } from "@/ui/ago";

interface Props {
  thread: ThreadData;
  docId: string;
  /** What the thread is about: the block's text. */
  quote: ReactNode;
  active: boolean;
  /** Shows the block in the page. */
  onLocate?: () => void;
}

/** One comment thread: the first comment, its replies, a box to reply, and "resolve". */
export function Thread({ thread, docId, quote, active, onLocate }: Props) {
  const { root, replies } = thread;
  const done = !!root.resolved_at;
  return (
    <article
      className={cx("rounded-lg border bg-surface p-2 transition-colors", active ? "border-move" : "border-line", onLocate && "cursor-pointer hover:border-line-strong")}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, a, textarea")) onLocate?.();
      }}
    >
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">{quote}</div>
        <IconButton size="sm" label={t(done ? "docs.comment.reopen" : "docs.comment.resolve")} onClick={() => resolveComment(root, !done)}>
          {done ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
        </IconButton>
      </div>
      <CommentBody comment={root} />
      {replies.map((reply) => (
        <CommentBody key={reply.id} comment={reply} reply />
      ))}
      {!done && (
        <div className="mt-2">
          <Composer placeholder={t("docs.comment.reply")} submitLabel={t("docs.comment.replySend")} onSubmit={(body) => addComment({ docId, parentId: root.id, body })} />
        </div>
      )}
    </article>
  );
}

function CommentBody({ comment, reply }: { comment: DocComment; reply?: boolean }) {
  const author = useMember(comment.author_id);
  const me = useMe();
  return (
    <div className={cx("group/c flex gap-2", reply ? "mt-2 border-t border-line pt-2" : "mt-0.5")}>
      <Avatar member={author} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium">{author?.name ?? t("common.someone")}</span>
          <time className="shrink-0 text-xs text-ink-3" title={exact(comment.created_at)}>
            <Ago ms={comment.created_at} />
          </time>
          {comment.author_id === me.user_id && (
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
      </div>
    </div>
  );
}
