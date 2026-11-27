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
  /** Whether Ctrl+M away from the text opens this page's box: the page shown, not a row's side peek. */
  answersKeys: boolean;
  /** The class that shows "Add comment" while the pointer is over the top of the page. */
  className?: string;
}

export function PageDiscussion({ docId, projectId, answersKeys, className }: Props) {
  const editor = usePageUi((s) => s.editor);
  const { open } = usePageThreads(docId, answersKeys ? editor : null);
  const threads = open.filter((th) => th.about.on !== "text");
  const mayEdit = useCan().edit(projectId);
  const focusThread = usePageUi((s) => s.focusThread);
  const litThread = usePageUi((s) => s.litThread);
  const replyAsked = usePageUi((s) => s.replyAsked);
  const asked = usePageUi((s) => (answersKeys ? s.pageBoxAsked : 0));
  const box = useRef<HTMLTextAreaElement>(null);
  const writing = asked > 0 && mayEdit;

  useEffect(() => {
    if (asked) box.current?.focus();
  }, [asked]);

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
            askReply={active && replyAsked?.thread === id ? replyAsked.n : 0}
            onOpen={active ? undefined : () => pageUi.openThread(id)}
            onLeave={active ? pageUi.leaveThread : undefined}
          />
        );
      })}
      {writing ? (
        <Composer
          ref={box}
          draft={draftFor.page(docId)}
          projectId={projectId}
          placeholder={t("docs.comment.onPage")}
          submitLabel={t("docs.comment.send")}
          onClose={pageUi.closePageBox}
          onCancel={pageUi.closePageBox}
          onSubmit={(comment) => {
            addComment({ docId, ...comment });
            pageUi.closePageBox();
          }}
        />
      ) : (
        mayEdit && (
          <button
            type="button"
            onClick={pageUi.commentOnPage}
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
