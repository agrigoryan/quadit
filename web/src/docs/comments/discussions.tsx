// The comments button in a page's header and the Discussions list it opens:
// the open threads in the order the page reads. A thread picked opens where
// it is, its words scrolled into view and flashed, the cursor in its reply
// box: in the margin beside its words, or in the comments column for one on
// the page as a whole, on words taken out or on a block gone (and wherever
// the page has no margin). "See all" opens the column, resolved threads and
// all.

import { MessageSquare } from "lucide-react";
import { useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMember } from "@/data/selectors";
import { type PageThread, useOpenThreads, usePageThreads } from "@/docs/comments/threads";
import { pageUi, usePageUi } from "@/docs/page/state";
import { Ago } from "@/ui/ago";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

export function Discussions({ docId }: { docId: string }) {
  const { total } = useOpenThreads(docId);
  const commentsOpen = usePageUi((s) => s.commentsOpen);
  const [open, setOpen] = useState(false);
  /** A thread was picked: the cursor goes to its reply box, not back to the button. */
  const picked = useRef(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className={cx("gap-1 px-2", (open || commentsOpen) && "bg-hover text-ink")}>
          <MessageSquare className="size-4" />
          <span className="max-sm:sr-only">{t("docs.comment.title")}</span>
          {total > 0 && (
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-move px-1 text-2xs font-semibold text-move-ink tnum">
              {total}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t("docs.comment.discussions")}
        className="w-80 p-1.5"
        onCloseAutoFocus={(e) => {
          if (picked.current) e.preventDefault();
          picked.current = false;
        }}
      >
        <List
          docId={docId}
          onPicked={() => {
            picked.current = true;
            setOpen(false);
          }}
          onSeeAll={() => {
            setOpen(false);
            pageUi.openComments();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The list itself: read from the page only while it is open. */
function List({ docId, onPicked, onSeeAll }: { docId: string; onPicked: () => void; onSeeAll: () => void }) {
  const editor = usePageUi((s) => s.editor);
  const { open } = usePageThreads(docId, editor);

  const pick = ({ root, at }: PageThread) => {
    onPicked();
    pageUi.openThread(root.id, !!at);
    if (!at || !editor) return;
    if ("words" in at) editor.scrollToThread(at.words);
    else editor.scrollToBlock(at.block);
  };

  return (
    <div>
      <header className="flex items-baseline gap-1.5 px-2 pt-1 pb-1.5">
        <h2 className="text-sm font-semibold">{t("docs.comment.discussions")}</h2>
        <span className="text-xs text-ink-3 tnum">{open.length}</span>
      </header>
      {open.length === 0 ? (
        <p className="px-2 pb-2 text-sm text-ink-2">{t("docs.comment.none")}</p>
      ) : (
        <ul className="max-h-[min(24rem,60vh)] overflow-y-auto">
          {open.map((th) => (
            <li key={th.root.id}>
              <Row thread={th} onPick={() => pick(th)} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 border-t border-line pt-1">
        <Button variant="ghost" size="sm" onClick={onSeeAll} className="w-full justify-start">
          {t("docs.comment.seeAll")}
        </Button>
      </div>
    </div>
  );
}

function Row({ thread: { root, about }, onPick }: { thread: PageThread; onPick: () => void }) {
  const author = useMember(root.author_id);
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
    >
      <Avatar member={author} size="sm" className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium">{author?.name ?? t("common.someone")}</span>
          <span className="shrink-0 text-xs text-ink-3">
            <Ago ms={root.created_at} />
          </span>
        </span>
        <span className="line-clamp-2 text-sm text-ink-2">{root.body}</span>
        {about.on === "text" && about.text && (
          <span className="mt-0.5 line-clamp-1 border-l-2 border-move pl-1.5 text-xs text-ink-3">{about.text}</span>
        )}
        {about.on === "removed" && (
          <span className="mt-0.5 block text-xs text-ink-3 italic">{t("docs.comment.wordsGone")}</span>
        )}
        {about.on === "gone" && (
          <span className="mt-0.5 block text-xs text-ink-3 italic">{t("docs.comment.blockGone")}</span>
        )}
        {about.on === "page" && (
          <span className="mt-0.5 block text-xs font-medium text-ink-3">{t("docs.comment.aboutPage")}</span>
        )}
      </span>
    </button>
  );
}
