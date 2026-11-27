// The discussion of a page as a whole, under its title, as Notion has it:
// the open threads on the page itself, and those whose words or block were
// taken out of it (they have nowhere else in the page to be), each short
// until opened; and "Add comment", shown when the pointer is over the top of
// the page (always on a touch screen), or straight away with Ctrl+M away
// from the text.

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { addComment } from "@/docs/actions";
import { Composer } from "@/docs/comments/composer";
import { draftFor } from "@/docs/comments/drafts";
import { Quote } from "@/docs/comments/quote";
import { Thread } from "@/docs/comments/thread";
import { aboutText, usePageThreads } from "@/docs/comments/threads";
import { pageUi, usePageUi } from "@/docs/page/state";

interface Props {
  docId: string;
  /** The page's project: who may not change it may read its comments, not add to them. */
  projectId: string | undefined;
  /** The class that shows "Add comment" while the pointer is over the top of the page. */
  className?: string;
}

export function PageDiscussion({ docId, projectId, className }: Props) {
  const { open } = usePageThreads(docId);
  const threads = open.filter((th) => th.about.on !== "text");
  const mayEdit = useCan().edit(projectId);
  const focusThread = usePageUi((s) => s.focusThread);
  const litThread = usePageUi((s) => s.litThread);
  const cursorAsked = usePageUi((s) => s.cursorAsked);
  const writing = usePageUi((s) => s.pageBox === docId) && mayEdit;
  const add = useRef<HTMLButtonElement>(null);
  /** The box was put away from inside it: the cursor goes to "Add comment", not nowhere. */
  const refocus = useRef(false);

  useEffect(() => {
    if (writing || !refocus.current) return;
    refocus.current = false;
    add.current?.focus();
  }, [writing]);
  const putAway = () => {
    refocus.current = true;
    pageUi.closePageBox();
  };

  if (threads.length === 0 && !mayEdit) return null;
  return (
    <section data-page-discussion aria-label={t("docs.comment.onPageList")} className="mt-3 space-y-2">
      {threads.map((th) => {
        const id = th.root.id;
        const active = id === focusThread;
        return (
          <Thread
            key={id}
            thread={th}
            docId={docId}
            projectId={projectId}
            quote={th.about.on === "page" ? undefined : <Quote about={th.about} />}
            subject={aboutText(th.about)}
            active={active}
            lit={id === litThread}
            compact={!active}
            askReply={active && cursorAsked === `reply ${id}`}
            onOpen={active ? undefined : () => pageUi.openThread(id)}
            onLeave={active ? pageUi.leaveThread : undefined}
          />
        );
      })}
      {writing ? (
        <Composer
          takeFocus={cursorAsked === `page ${docId}`}
          onFocusTaken={pageUi.cursorTaken}
          draft={draftFor.page(docId)}
          projectId={projectId}
          placeholder={t("docs.comment.onPage")}
          submitLabel={t("docs.comment.send")}
          onClose={putAway}
          onCancel={putAway}
          onSubmit={(comment) => {
            const sent = addComment({ docId, ...comment });
            putAway();
            return sent;
          }}
        />
      ) : (
        mayEdit && (
          <button
            ref={add}
            type="button"
            onClick={() => pageUi.commentOnPage(docId)}
            className={cx(
              "flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm text-ink-2 hover:bg-hover hover:text-ink focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
              threads.length === 0 && className,
            )}
          >
            <MessageSquarePlus className="size-4" />
            {t("docs.comment.addOnPage")}
          </button>
        )
      )}
    </section>
  );
}
