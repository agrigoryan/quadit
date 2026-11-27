// The comments pane: every thread of a page in one list, beside it ("See
// all" in the Discussions list), as Notion's and Google Docs' are. Those
// last written in come first; the open ones or the resolved, of anyone or
// of one person. A thread is answered and resolved here, and a click on it
// brings it into view in the page and opens it there.

import { Check, ChevronDown, MessageSquare, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLookupEvenIfGone } from "@/data/selectors";
import { useHotkeys } from "@/hooks/hotkeys";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { Quote } from "@/docs/comments/quote";
import { Thread } from "@/docs/comments/thread";
import { aboutText, lastActivity, type PageThread, showInPage, usePageThreads } from "@/docs/comments/threads";
import { pageUi, usePageUi } from "@/docs/page/state";
import { IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/ui/menu";
import { Radio, RadioGroup } from "@/ui/radio-group";

interface Props {
  docId: string;
  /** The page's project: who may not change it may read its comments, not answer them. */
  projectId: string | undefined;
}

const ANYONE = "";

/** Whether someone wrote in a thread: its first comment or a reply. */
const wroteIn = (th: PageThread, userId: string) =>
  th.root.author_id === userId || th.replies.some((r) => r.author_id === userId);

export function CommentsPanel({ docId, projectId }: Props) {
  const editor = usePageUi((s) => s.editors[docId]) ?? null;
  const focusThread = usePageUi((s) => s.focusThread);
  const litThread = usePageUi((s) => s.litThread);
  const showResolved = usePageUi((s) => s.showResolved);
  const members = useLookupEvenIfGone("members");
  const [person, setPerson] = useState(ANYONE);
  const list = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  // Asked for (See all, open or not), the pane has the cursor; closed, the cursor goes back to the
  // comments button, not nowhere.
  const asked = usePageUi((s) => s.cursorAsked === "pane");
  useLayoutEffect(() => {
    if (!asked) return;
    aside.current?.focus({ preventScroll: true });
    pageUi.cursorTaken();
  }, [asked]);
  useLayoutEffect(() => {
    const el = aside.current;
    return () => {
      const at = document.activeElement;
      if (!at || at === document.body || el?.contains(at))
        document.querySelector<HTMLElement>("[data-discussions]")?.focus({ preventScroll: true });
    };
  }, []);
  // Esc in a comment box leaves the box (composer.tsx); away from one, it closes the pane.
  useHotkeys({ Escape: pageUi.closeComments });
  const { open, resolved } = usePageThreads(docId);

  // The thread open in the page is shown here too.
  useEffect(() => {
    if (focusThread) list.current?.querySelector("[aria-current]")?.scrollIntoView?.({ block: "nearest" });
  }, [focusThread]);

  const recent = (threads: PageThread[]) => [...threads].sort((a, b) => lastActivity(b) - lastActivity(a));
  const writers = [
    ...new Set([...open, ...resolved].flatMap((th) => [th.root, ...th.replies].map((c) => c.author_id))),
  ];
  const shown = recent(showResolved ? resolved : open).filter((th) => person === ANYONE || wroteIn(th, person));
  /** An open thread is opened where the page shows it; a resolved one's words are shown while they are there. */
  const locate = (th: PageThread) => {
    if (!th.root.resolved_at)
      return () => {
        // Over the page (a phone, a narrow window), the pane goes first: the thread opens where it can be seen.
        if (aside.current && getComputedStyle(aside.current).position !== "static") pageUi.closeComments();
        pageUi.openThread(th.root.id);
        showInPage(th, editor);
      };
    return th.at ? () => showInPage(th, editor) : undefined;
  };

  return (
    <aside
      ref={aside}
      tabIndex={-1}
      data-comments
      aria-label={t("docs.comment.title")}
      className="absolute inset-y-0 right-0 z-20 flex outline-none w-[min(22rem,100%)] shrink-0 flex-col border-l border-line bg-surface shadow-panel animate-panel max-sm:w-full max-sm:border-l-0 xl:static xl:z-auto xl:w-80 xl:animate-none xl:shadow-none"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3">
        <h2 className="flex-1 text-sm font-semibold">{t("docs.comment.title")}</h2>
        <IconButton label={t("common.close")} onClick={pageUi.closeComments}>
          <X className="size-4" />
        </IconButton>
      </header>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
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
              <span className="text-ink-2 tnum">{which === "resolved" ? resolved.length : open.length}</span>
            </Radio>
          ))}
        </RadioGroup>
        <Menu>
          <MenuTrigger
            aria-label={t("docs.comment.whose")}
            className="ml-auto flex h-6 max-w-40 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-ink-2 hover:bg-hover hover:text-ink"
          >
            <span className="truncate">{person === ANYONE ? t("docs.comment.anyone") : members[person]?.name}</span>
            <ChevronDown className="size-3 shrink-0" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuRadioGroup value={person} onValueChange={setPerson}>
              <MenuRadioItem value={ANYONE}>{t("docs.comment.anyone")}</MenuRadioItem>
              {writers.map((id) => (
                <MenuRadioItem key={id} value={id}>
                  {members[id]?.name ?? t("common.someone")}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </div>

      <div ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {shown.map((th) => (
          <Thread
            key={th.root.id}
            thread={th}
            docId={docId}
            projectId={projectId}
            quote={<Quote about={th.about} />}
            subject={aboutText(th.about)}
            active={th.root.id === focusThread}
            lit={th.root.id === litThread}
            onLocate={locate(th)}
          />
        ))}
        {shown.length === 0 && (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            {showResolved ? <Check className="size-5 text-ink-3" /> : <MessageSquare className="size-5 text-ink-3" />}
            <p className="text-sm text-ink-2">{t(showResolved ? "docs.comment.noneResolved" : "docs.comment.none")}</p>
            {!showResolved && <p className="text-xs text-ink-2">{t("docs.comment.hint")}</p>}
          </div>
        )}
      </div>
    </aside>
  );
}
