// The threads of one block, opened in place where the page has no margin
// for cards (a narrower window, a database row's side peek): Notion's
// "minimal" comments. The block shows a mark with its count just past its
// text (editor/markers.tsx); clicking it, or highlighted words, or starting
// a thread there opens the block's threads in a popover hung from that
// mark, or on a phone in a sheet from the bottom. A new thread is written
// there too.

import { type RefObject, useEffect, useMemo, useRef } from "react";
import { useCan } from "@/data/access";
import { useMedia } from "@/hooks/use-media";
import { t } from "@/lib/i18n";
import { addComment } from "@/docs/actions";
import { Composer } from "@/docs/comments/composer";
import { draftFor } from "@/docs/comments/drafts";
import { Quote } from "@/docs/comments/quote";
import { Thread } from "@/docs/comments/thread";
import { inText, onWords, threadsOf } from "@/docs/comments/threads";
import { useDocComments } from "@/docs/data";
import { pageUi, usePageUi } from "@/docs/page/state";
import { Dialog } from "@/ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";

interface Props {
  docId: string;
  /** The page's project: who may not change it may read its comments, not add to them. */
  projectId: string | undefined;
  /** The page's text column, where the block and its mark are. */
  text: RefObject<HTMLElement | null>;
}

/** What a popover hangs from: the block's comment mark, or where it would be, at the end of its first line. */
function markOf(column: HTMLElement | null, block: string): DOMRect {
  const mark = column?.querySelector(`.qd-thread-mark[data-block="${CSS.escape(block)}"]`);
  if (mark) return mark.getBoundingClientRect();
  const content = column?.querySelector(
    `.bn-block-outer[data-id="${CSS.escape(block)}"] > .bn-block > .bn-block-content`,
  );
  const r = content?.getBoundingClientRect();
  return r ? new DOMRect(r.right, r.top, 1, Math.min(r.height, 24)) : new DOMRect();
}

export function BlockThreads({ docId, projectId, text }: Props) {
  const comments = useDocComments(docId);
  const threads = useMemo(() => threadsOf(comments).filter((th) => !th.root.resolved_at && inText(th)), [comments]);
  const mayEdit = useCan().edit(projectId);
  const focusThread = usePageUi((s) => s.focusThread);
  const focusBlock = usePageUi((s) => s.focusBlock);
  const draftBlock = usePageUi((s) => s.draftBlock);
  const draftWords = usePageUi((s) => s.draftWords);
  const replyAsked = usePageUi((s) => s.replyAsked);
  const litThread = usePageUi((s) => s.litThread);
  const phone = useMedia("(max-width: 640px)");
  const draft = mayEdit ? draftBlock : null;
  const asked = focusThread ? threads.find((th) => th.root.id === focusThread) : undefined;
  const block = draft ?? asked?.blockId ?? focusBlock;
  const shown = block ? threads.filter((th) => th.blockId === block) : [];
  const first = shown[0]?.root.id;
  const open = !!block && (!!draft || shown.length > 0);
  const content = useRef<HTMLDivElement>(null);
  const anchor = useMemo(
    () => ({ current: { getBoundingClientRect: () => markOf(text.current, block ?? "") } }),
    [text, block],
  );

  const close = () => {
    pageUi.endDraft();
    pageUi.leaveThread();
  };
  /** The block last shown, for the cursor to go back to once the popover has closed. */
  const lastBlock = useRef(block);
  useEffect(() => {
    if (block) lastBlock.current = block;
  }, [block]);
  /** Back where the person was: the block's mark when there is one, else the text. */
  const back = () =>
    (
      text.current?.querySelector<HTMLElement>(
        `.qd-thread-mark[data-block="${CSS.escape(lastBlock.current ?? "")}"]`,
      ) ?? text.current?.querySelector<HTMLElement>(".bn-editor")
    )?.focus();

  const draftKey = draft ? draftFor.thread(draft, draftWords) : "";
  const body = (
    <div className="space-y-2">
      {draft && (
        <div key={draftKey} className="rounded-lg border border-accent bg-surface p-2">
          {draftWords && <Quote about={{ on: "text", text: draftWords.quote }} />}
          <Composer
            autoFocus
            draft={draftKey}
            projectId={projectId}
            placeholder={t(draftWords ? "docs.comment.placeholderWords" : "docs.comment.placeholder")}
            submitLabel={t("docs.comment.send")}
            onClose={pageUi.endDraft}
            onCancel={pageUi.endDraft}
            onSubmit={(comment) => {
              addComment({ docId, blockId: draft, words: draftWords ?? undefined, ...comment });
              pageUi.endDraft();
            }}
          />
        </div>
      )}
      {shown.map((th) => {
        const id = th.root.id;
        const active = id === focusThread || (!focusThread && id === first && !draft);
        return (
          <Thread
            key={id}
            thread={th}
            docId={docId}
            projectId={projectId}
            // Words quoted, as several threads may be on one block; a thread on the block needs none.
            quote={onWords(th.root) && <Quote about={{ on: "text", text: th.root.quote }} />}
            subject={th.root.quote}
            active={active}
            lit={id === litThread}
            askReply={replyAsked && (replyAsked.thread ?? first) === id ? replyAsked.n : 0}
            onResolved={shown.length === 1 && !draft ? close : undefined}
          />
        );
      })}
    </div>
  );

  if (phone)
    return (
      <Dialog open={open} onOpenChange={(to) => !to && close()} title={t("docs.comment.title")}>
        <div className="px-4 pb-4">{body}</div>
      </Dialog>
    );

  return (
    <Popover open={open} onOpenChange={(to) => !to && close()}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        ref={content}
        side="bottom"
        align="end"
        aria-label={t("docs.comment.title")}
        className="w-80 p-2"
        // The cursor goes to a box when one asked for it (threads.tsx and the new thread's box do that);
        // clicked words leave it in the text, where it was put.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!document.activeElement || document.activeElement === document.body) back();
        }}
        // Esc closing the @ list in a box closes only that list.
        onEscapeKeyDown={(e) => {
          if (content.current?.querySelector('[role="listbox"]')) e.preventDefault();
        }}
        // A box being written keeps the popover: its draft is kept anyway, but it stays in sight.
        onInteractOutside={(e) => {
          const target = e.target instanceof Element ? e.target : null;
          // The words of the thread shown, clicked again, keep it.
          if (
            draft ||
            (focusThread && target?.closest(`[data-style-type="comment"][data-value~="${CSS.escape(focusThread)}"]`))
          )
            e.preventDefault();
        }}
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}
