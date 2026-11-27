// The comments of a page, in a column beside it: one thread per comment on
// words of the page, a block, or the page as a whole, with its replies.
// Threads follow the order of the blocks they are on. Where the page has no
// room for its margin (comments/margin.tsx), this is where threads open; it
// is also "See all" in the Discussions list, with the resolved threads.

import { MessageSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCan } from "@/data/access";
import { useHotkeys } from "@/hooks/hotkeys";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { addComment } from "@/docs/actions";
import { Composer } from "@/docs/comments/composer";
import { Quote } from "@/docs/comments/quote";
import { Thread } from "@/docs/comments/thread";
import { aboutText, type PageThread, usePageThreads } from "@/docs/comments/threads";
import type { EditorHandle } from "@/docs/editor/editor";
import { pageUi, usePageUi } from "@/docs/page/state";
import { IconButton } from "@/ui/button";
import { Radio, RadioGroup } from "@/ui/radio-group";

interface Props {
  docId: string;
  /** The page's project: who may not change it may read its comments, not add to them. */
  projectId: string | undefined;
  /** The page's editor, read for the threads' order and quotes; null until it has drawn. */
  editor: EditorHandle | null;
  /** The page cannot take comments on blocks (no editor shown). */
  pageOnly?: boolean;
}

export function CommentsPanel({ docId, projectId, editor, pageOnly }: Props) {
  const readOnly = !useCan().edit(projectId);
  const draftBlock = usePageUi((s) => s.draftBlock);
  const draftWords = usePageUi((s) => s.draftWords);
  const focusBlock = usePageUi((s) => s.focusBlock);
  const focusThread = usePageUi((s) => s.focusThread);
  const litThread = usePageUi((s) => s.litThread);
  const showResolved = usePageUi((s) => s.showResolved);
  const pageBoxAsked = usePageUi((s) => s.pageBoxAsked);
  const replyAsked = usePageUi((s) => s.replyAsked);
  const pageBox = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Esc in a comment box leaves the box (composer.tsx); away from one, it closes the column.
  useHotkeys({ Escape: pageUi.closeComments });
  const { open, resolved, draftText } = usePageThreads(docId, editor, draftBlock);

  useEffect(() => {
    if (pageBoxAsked) pageBox.current?.focus();
  }, [pageBoxAsked]);

  // The thread asked for comes into view in the list.
  useEffect(() => {
    if (focusThread || focusBlock)
      list.current?.querySelector("[aria-current]")?.scrollIntoView?.({ block: "nearest" });
  }, [focusThread, focusBlock]);

  const shown = showResolved ? resolved : open;
  /** Shows a thread's words or block in the page, while they are there. */
  const locate = ({ at }: PageThread) => {
    if (!at || !editor) return undefined;
    return "words" in at ? () => editor.scrollToThread(at.words) : () => editor.scrollToBlock(at.block);
  };

  return (
    <aside
      data-comments
      aria-label={t("docs.comment.title")}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(22rem,100%)] shrink-0 flex-col border-l border-line bg-surface shadow-panel animate-panel max-sm:w-full max-sm:border-l-0 xl:static xl:z-auto xl:w-80 xl:animate-none xl:shadow-none"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3">
        <h2 className="flex-1 text-sm font-semibold">{t("docs.comment.title")}</h2>
        <RadioGroup
          label={t("docs.comment.which")}
          value={showResolved ? "resolved" : "open"}
          onChange={(which) => pageUi.setShowResolved(which === "resolved")}
          className="flex rounded-md bg-sunken p-0.5 text-xs font-medium"
        >
          {(["open", "resolved"] as const).map((which) => (
            <Radio
              key={which}
              value={which}
              className={cx(
                "h-5 rounded-sm px-2",
                showResolved === (which === "resolved")
                  ? "bg-surface text-ink shadow-card"
                  : "text-ink-2 hover:text-ink",
              )}
            >
              {t(`docs.comment.${which}`)}{" "}
              <span className="text-ink-3 tnum">{which === "resolved" ? resolved.length : open.length}</span>
            </Radio>
          ))}
        </RadioGroup>
        <IconButton label={t("common.close")} onClick={pageUi.closeComments}>
          <X className="size-4" />
        </IconButton>
      </header>

      <div ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {draftBlock && !showResolved && !readOnly && (
          <div className="rounded-lg border border-accent bg-surface p-2">
            <Quote about={{ on: "text", text: draftWords?.quote ?? draftText }} />
            <Composer
              autoFocus
              placeholder={t(draftWords ? "docs.comment.placeholderWords" : "docs.comment.placeholder")}
              submitLabel={t("docs.comment.send")}
              onCancel={pageUi.endDraft}
              onSubmit={(comment) => {
                addComment({ docId, blockId: draftBlock, words: draftWords ?? undefined, ...comment });
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
            projectId={projectId}
            quote={<Quote about={th.about} />}
            subject={aboutText(th.about)}
            active={th.root.id === focusThread || (!!th.blockId && th.blockId === focusBlock)}
            lit={th.root.id === litThread}
            askReply={replyAsked?.thread === th.root.id ? replyAsked.n : 0}
            onLocate={locate(th)}
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

      {!showResolved && !readOnly && (
        <footer className="shrink-0 border-t border-line p-2">
          <Composer
            ref={pageBox}
            placeholder={t("docs.comment.onPage")}
            submitLabel={t("docs.comment.send")}
            onSubmit={(comment) => addComment({ docId, ...comment })}
          />
        </footer>
      )}
    </aside>
  );
}
