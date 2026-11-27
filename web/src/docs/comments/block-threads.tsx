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
import { aboutText, inText, onWords, threadsOf, usePageThreads } from "@/docs/comments/threads";
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
  const draftBlock = usePageUi((s) => (s.draftDoc === docId ? s.draftBlock : null));
  const draftWords = usePageUi((s) => s.draftWords);
  const cursorAsked = usePageUi((s) => s.cursorAsked);
  const litThread = usePageUi((s) => s.litThread);
  const phone = useMedia("(max-width: 640px)");
  const draft = mayEdit ? draftBlock : null;
  const asked = focusThread ? threads.find((th) => th.root.id === focusThread) : undefined;
  const block = draft ?? asked?.blockId ?? focusBlock;
  // As the page's text reads now: a thread whose block is gone is not here but under the page's title
  // (page-discussion.tsx), and one whose words are gone, nowhere until the server says so.
  const { open: read, read: known } = usePageThreads(docId);
  const shown = block ? read.filter((th) => th.at && th.blockId === block) : [];
  const first = shown[0]?.root.id;
  const open = !!block && (!!draft || shown.length > 0);
  const content = useRef<HTMLDivElement>(null);
  // A virtual anchor at the block's mark, within the page's text: the popover follows it as the page scrolls.
  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => markOf(text.current, block ?? ""),
        get contextElement() {
          return text.current ?? undefined;
        },
      },
    }),
    [text, block],
  );

  // A mark clicked whose threads turn out to have nothing left in the text (their words taken out a
  // moment ago): nothing is open, and Esc is the page's again.
  const nothingThere = !!block && !draft && known && shown.length === 0 && !!focusBlock;
  useEffect(() => {
    if (nothingThere) pageUi.leaveThread();
  }, [nothingThere]);

  const close = () => {
    pageUi.endDraft();
    pageUi.leaveThread();
  };
  /** The block last shown, for the cursor to go back to once the popover has closed. */
  const lastBlock = useRef(block);
  useEffect(() => {
    if (block) lastBlock.current = block;
  }, [block]);
  /** Where the person was: the block's mark when there is one, else the text. */
  const backTo = () =>
    text.current?.querySelector<HTMLElement>(`.qd-thread-mark[data-block="${CSS.escape(lastBlock.current ?? "")}"]`) ??
    text.current?.querySelector<HTMLElement>(".bn-editor");

  const draftKey = draft ? draftFor.thread(draft, draftWords) : "";

  const body = (
    <div className="space-y-2">
      {draft && (
        <div key={draftKey} data-draft className="rounded-lg border border-accent bg-surface p-2">
          {draftWords && <Quote about={{ on: "text", text: draftWords.quote }} />}
          <Composer
            // The cursor when it was asked for just now, not when the box is drawn again later.
            takeFocus={cursorAsked === "draft"}
            onFocusTaken={pageUi.cursorTaken}
            draft={draftKey}
            projectId={projectId}
            placeholder={t(draftWords ? "docs.comment.placeholderWords" : "docs.comment.placeholder")}
            submitLabel={t("docs.comment.send")}
            onClose={pageUi.endDraft}
            onCancel={pageUi.endDraft}
            onSubmit={(comment) => {
              const sent = addComment({ docId, blockId: draft, words: draftWords ?? undefined, ...comment });
              pageUi.endDraft();
              return sent;
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
            // The words as they read now, as several threads may be on one block; a thread on the block needs none.
            quote={onWords(th.root) && <Quote about={th.about} />}
            subject={onWords(th.root) ? aboutText(th.about) : undefined}
            active={active}
            lit={id === litThread}
            askReply={cursorAsked === `reply ${id}` || (cursorAsked === "block" && id === first)}
            onResolved={shown.length === 1 && !draft ? close : undefined}
          />
        );
      })}
    </div>
  );

  if (phone)
    return (
      <Dialog
        open={open}
        onOpenChange={(to) => !to && close()}
        title={t("docs.comment.title")}
        // The thread shown takes the cursor (its reply box, or itself for one who may not reply), not
        // whichever box comes first; closed, it goes back where the person was.
        initialFocus={(root) =>
          root.querySelector<HTMLElement>("[data-draft] textarea") ??
          root.querySelector<HTMLElement>("[aria-current] textarea") ??
          root.querySelector<HTMLElement>("[aria-current]")
        }
        finalFocus={backTo}
      >
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
          // Closed for good, not opened again at once on another block (this comes a moment later).
          const { focusThread, focusBlock, draftBlock } = usePageUi.getState();
          const reopened = !!(focusThread || focusBlock || draftBlock);
          if (!reopened && (!document.activeElement || document.activeElement === document.body)) backTo()?.focus();
        }}
        // Esc closing the @ list in a box closes only that list.
        onEscapeKeyDown={(e) => {
          if (content.current?.querySelector('[role="listbox"]')) e.preventDefault();
        }}
        // A box being written keeps the popover: its draft is kept anyway, but it stays in sight. A
        // block's mark or highlighted words, clicked, say for themselves what opens next.
        onInteractOutside={(e) => {
          const target = e.target instanceof Element ? e.target : null;
          // Another dialog opened over the page (its versions, a file shown): the popover gives way, its
          // draft kept, rather than stay over that dialog.
          if (target?.closest('[role="dialog"]')) return;
          if (draft || target?.closest('.qd-thread-mark, [data-style-type="comment"]')) e.preventDefault();
        }}
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}
