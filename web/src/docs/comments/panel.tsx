// The comments of a page, in a column beside it: one thread per comment on
// a block (or on the page as a whole), with its replies. Threads follow the
// order of the blocks they are on.

import { MessageSquare, X } from "lucide-react";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { addComment } from "@/docs/actions";
import { Composer } from "@/docs/comments/composer";
import { Thread } from "@/docs/comments/thread";
import { useDocComments } from "@/docs/data";
import type { EditorHandle } from "@/docs/editor/editor";
import { pageUi, usePageUi } from "@/docs/page/state";
import type { DocComment } from "@/lib/types-docs";
import { IconButton } from "@/ui/button";

export interface ThreadData {
  root: DocComment;
  replies: DocComment[];
  /** The block it is on; undefined for a comment on the page itself. */
  blockId?: string;
}

/** Comments grouped into threads: each top-level comment with its replies. */
function threadsOf(comments: DocComment[]): ThreadData[] {
  const byRoot = new Map<string, ThreadData>();
  for (const c of comments) {
    if (!c.parent_id)
      byRoot.set(c.id, { root: c, replies: [], blockId: c.subject_type === "doc_block" ? c.subject_id : undefined });
  }
  for (const c of comments) {
    if (c.parent_id) byRoot.get(c.parent_id)?.replies.push(c);
  }
  return [...byRoot.values()];
}

/** How many open threads each block has, and how many the page has in all. */
export function useOpenThreads(docId: string): { perBlock: Record<string, number>; total: number } {
  const comments = useDocComments(docId);
  return useMemo(() => {
    const perBlock: Record<string, number> = {};
    let total = 0;
    for (const th of threadsOf(comments)) {
      if (th.root.resolved_at) continue;
      total++;
      if (th.blockId) perBlock[th.blockId] = (perBlock[th.blockId] ?? 0) + 1;
    }
    return { perBlock, total };
  }, [comments]);
}

interface Props {
  docId: string;
  editor: RefObject<EditorHandle | null>;
  /** The page cannot take comments on blocks (no editor shown). */
  pageOnly?: boolean;
}

export function CommentsPanel({ docId, editor, pageOnly }: Props) {
  const comments = useDocComments(docId);
  const draftBlock = usePageUi((s) => s.draftBlock);
  const focusBlock = usePageUi((s) => s.focusBlock);
  const showResolved = usePageUi((s) => s.showResolved);
  const [order, setOrder] = useState<string[]>([]);

  // The blocks' order, to list threads the way the page reads.
  useEffect(() => {
    setOrder(editor.current?.order() ?? []);
  }, [editor, comments, draftBlock, focusBlock]);

  const { open, resolved } = useMemo(() => {
    const place = new Map(order.map((id, i) => [id, i]));
    const rank = (th: ThreadData) => (th.blockId ? (place.get(th.blockId) ?? order.length) : order.length + 1);
    const all = threadsOf(comments).sort((a, b) => rank(a) - rank(b) || a.root.created_at - b.root.created_at);
    return { open: all.filter((th) => !th.root.resolved_at), resolved: all.filter((th) => th.root.resolved_at) };
  }, [comments, order]);

  const shown = showResolved ? resolved : open;
  const quote = (blockId: string | undefined) => (blockId ? editor.current?.blockText(blockId) : undefined);

  return (
    <aside
      aria-label={t("docs.comment.title")}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(22rem,100%)] shrink-0 flex-col border-l border-line bg-surface shadow-panel animate-panel xl:static xl:z-auto xl:w-80 xl:animate-none xl:shadow-none"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3">
        <h2 className="flex-1 text-sm font-semibold">{t("docs.comment.title")}</h2>
        <div className="flex rounded-md bg-sunken p-0.5 text-xs font-medium">
          {([false, true] as const).map((res) => (
            <button
              key={String(res)}
              type="button"
              aria-pressed={showResolved === res}
              onClick={() => pageUi.setShowResolved(res)}
              className={cx(
                "h-5 rounded-sm px-2",
                showResolved === res ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
              )}
            >
              {t(res ? "docs.comment.resolved" : "docs.comment.open")}{" "}
              <span className="text-ink-3 tnum">{res ? resolved.length : open.length}</span>
            </button>
          ))}
        </div>
        <IconButton label={t("common.close")} onClick={pageUi.closeComments}>
          <X className="size-4" />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {draftBlock && !showResolved && (
          <div className="rounded-lg border border-accent bg-surface p-2">
            <Quote text={quote(draftBlock)} />
            <Composer
              autoFocus
              placeholder={t("docs.comment.placeholder")}
              submitLabel={t("docs.comment.send")}
              onCancel={pageUi.endDraft}
              onSubmit={(body) => {
                addComment({ docId, blockId: draftBlock, body });
                pageUi.endDraft();
              }}
            />
          </div>
        )}
        {shown.map((th) => (
          <Thread
            key={th.root.id}
            thread={th}
            docId={docId}
            quote={
              <Quote
                text={quote(th.blockId)}
                gone={!!th.blockId && quote(th.blockId) === undefined}
                page={!th.blockId}
              />
            }
            active={!!th.blockId && th.blockId === focusBlock}
            onLocate={th.blockId ? () => editor.current?.scrollToBlock(th.blockId as string) : undefined}
          />
        ))}
        {shown.length === 0 && !draftBlock && (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <MessageSquare className="size-5 text-ink-3" />
            <p className="text-sm text-ink-2">{t(showResolved ? "docs.comment.noneResolved" : "docs.comment.none")}</p>
            {!showResolved && !pageOnly && <p className="text-xs text-ink-3">{t("docs.comment.hint")}</p>}
          </div>
        )}
      </div>

      {!showResolved && (
        <footer className="shrink-0 border-t border-line p-2">
          <Composer
            placeholder={t("docs.comment.onPage")}
            submitLabel={t("docs.comment.send")}
            onSubmit={(body) => addComment({ docId, body })}
          />
        </footer>
      )}
    </aside>
  );
}

function Quote({ text, gone, page }: { text: string | undefined; gone?: boolean; page?: boolean }) {
  if (page) return <p className="mb-1.5 text-xs font-medium text-ink-3">{t("docs.comment.aboutPage")}</p>;
  if (gone) return <p className="mb-1.5 text-xs text-ink-3 italic">{t("docs.comment.blockGone")}</p>;
  if (!text) return null;
  return <p className="mb-1.5 line-clamp-2 border-l-2 border-move pl-2 text-xs text-ink-2">{text}</p>;
}
