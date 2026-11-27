// The open threads on a page's text, as cards in a margin beside it, each
// level with its words or its block (comments/stack.ts shares the room
// out). One is open at a time, the others compact: the thread whose words
// were clicked, whose card was, or that was picked from the Discussions
// list. A new thread is written here too, beside its block. Threads on the
// page as a whole, on words taken out or on a block gone are not here: they
// are in the comments column (panel.tsx), which is also where every thread
// opens when the page has no room for a margin.
//
// Keeping up with the page is cheap: the cards are measured at most once a
// frame, after the text changed (typed here or by someone else), the text
// column or a card changed size (pictures, folding, the window, a card
// opening) or fonts arrived. A measure only reads (one box per thread),
// then sets the cards' places in one go, and only when one moved; a card
// moves by a transform, which needs no new layout of the page.

import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useCan } from "@/data/access";
import { useHotkeys } from "@/hooks/hotkeys";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { addComment } from "@/docs/actions";
import { Composer } from "@/docs/comments/composer";
import { stackCards, type Card } from "@/docs/comments/stack";
import { Thread } from "@/docs/comments/thread";
import { inText, onWords, threadsOf } from "@/docs/comments/threads";
import { useDocComments } from "@/docs/data";
import { pageUi, usePageUi } from "@/docs/page/state";

interface Props {
  docId: string;
  /** The page's project: who may not change it may read its comments, not add to them. */
  projectId: string | undefined;
  /** The page's text column: where the words are found, and where a click away from them leaves a thread. */
  text: RefObject<HTMLElement | null>;
  className?: string;
}

/** Space between two cards, in pixels. */
const GAP = 8;
/** The card of the new thread being written. */
const DRAFT = "draft";

/** A card's place: how far down the margin, and the words or block text it is on (its name). Null: not in the page now. */
type Place = { top: number; label: string } | null;

export function Margin({ docId, projectId, text, className }: Props) {
  const comments = useDocComments(docId);
  const threads = useMemo(() => threadsOf(comments).filter((th) => !th.root.resolved_at && inText(th)), [comments]);
  const mayEdit = useCan().edit(projectId);
  const editor = usePageUi((s) => s.editor);
  const focusThread = usePageUi((s) => s.focusThread);
  const focusBlock = usePageUi((s) => s.focusBlock);
  const litThread = usePageUi((s) => s.litThread);
  const draftBlock = usePageUi((s) => s.draftBlock);
  const draftWords = usePageUi((s) => s.draftWords);
  const replyAsked = usePageUi((s) => s.replyAsked);
  const draft = mayEdit ? draftBlock : null;
  const active = draft ? DRAFT : (focusThread ?? threads.find((th) => th.blockId === focusBlock)?.root.id ?? null);

  const aside = useRef<HTMLElement>(null);
  const draftBox = useRef<HTMLTextAreaElement>(null);
  /** Where each card is, by id (a card not in here has not been measured yet), and which slide there. */
  const [layout, setLayout] = useState<{ places: Record<string, Place>; sliding: string[] }>({
    places: {},
    sliding: [],
  });
  const { places } = layout;
  /** The open card the places were last worked out for: a new one, and the cards slide to make room for it. */
  const placedFor = useRef(active);

  /** What each card is beside, as one string: the measuring below starts again only when it changes. */
  const anchors = [
    ...(draft ? [`${DRAFT} block ${draft}`] : []),
    ...threads.map((th) =>
      onWords(th.root) ? `${th.root.id} words ${th.root.id}` : `${th.root.id} block ${th.blockId ?? ""}`,
    ),
  ].join("\n");

  useEffect(() => {
    const margin = aside.current;
    const column = text.current;
    if (!margin || !column || !anchors) return;
    const wanted = anchors.split("\n").map((line) => {
      const [id = "", kind, target = ""] = line.split(" ");
      return { id, words: kind === "words" ? target : undefined, block: kind === "block" ? target : undefined };
    });
    let frame = 0;
    const measure = () => {
      frame = 0;
      const base = margin.getBoundingClientRect().top;
      const cards: Card[] = [];
      const labels = new Map<string, string>();
      for (const { id, words, block } of wanted) {
        const found = words ? wordsIn(column, words) : block ? blockIn(column, block) : undefined;
        if (!found) continue;
        const card = margin.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`);
        cards.push({ id, want: Math.round(found.top - base), height: card?.offsetHeight ?? 0 });
        labels.set(id, found.label);
      }
      const tops = stackCards(cards, active, GAP);
      // Cards already in place slide when another one opens; when the text moves under them (typing,
      // a picture, the page loading), they keep up at once.
      const slide = placedFor.current !== active;
      placedFor.current = active;
      setLayout((before) => {
        const next: Record<string, Place> = {};
        for (const { id } of wanted) {
          const top = tops.get(id);
          next[id] = top === undefined ? null : { top, label: labels.get(id) ?? "" };
        }
        if (JSON.stringify(next) === JSON.stringify(before.places)) return before;
        return { places: next, sliding: slide ? wanted.map((w) => w.id).filter((id) => before.places[id]) : [] };
      });
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    soon();
    const stop = editor?.onChange(soon);
    const sizes = new ResizeObserver(soon);
    sizes.observe(column);
    for (const card of margin.querySelectorAll("[data-card]")) sizes.observe(card);
    document.fonts.addEventListener("loadingdone", soon);
    return () => {
      cancelAnimationFrame(frame);
      stop?.();
      sizes.disconnect();
      document.fonts.removeEventListener("loadingdone", soon);
    };
  }, [anchors, active, editor, text]);

  // A new thread's box takes the cursor where it is, without the page jumping to it before it is placed.
  useEffect(() => {
    if (draft) draftBox.current?.focus({ preventScroll: true });
  }, [draft]);

  // A click in the text away from the open thread's words leaves the thread; Esc does too.
  const leaving = !!active && active !== DRAFT;
  useEffect(() => {
    if (!leaving) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !text.current?.contains(target) || target.closest('[data-style-type="comment"]')) return;
      pageUi.leaveThread();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [leaving, text]);
  useHotkeys({ Escape: pageUi.leaveThread }, { enabled: leaving });

  /** Back to the text after a new thread is sent or put away, where the cursor was before. */
  const backToText = () => text.current?.querySelector<HTMLElement>(".bn-editor")?.focus();

  // The cards in the order they stand, the page's order: Tab goes through them so.
  const ids = [...(draft ? [DRAFT] : []), ...threads.map((th) => th.root.id)];
  const order = ids
    .map((id, i) => ({ id, top: places[id]?.top ?? Infinity, i }))
    .sort((a, b) => a.top - b.top || a.i - b.i);
  const byId = new Map(threads.map((th) => [th.root.id, th]));

  return (
    <aside ref={aside} aria-label={t("docs.comment.title")} className={cx("relative", className)}>
      {order.map(({ id }) => {
        const place = places[id];
        const open = id === active;
        const th = byId.get(id);
        return (
          <div
            key={id}
            data-card={id}
            hidden={place === null}
            className={cx(
              "absolute inset-x-0 top-0",
              place === undefined && "opacity-0",
              layout.sliding.includes(id) && "transition-transform duration-150 ease-out",
              open ? "z-10 [&>*]:shadow-pop" : "[&>*]:shadow-card",
            )}
            style={place ? { transform: `translateY(${place.top}px)` } : undefined}
          >
            {th ? (
              <Thread
                thread={th}
                docId={docId}
                projectId={projectId}
                subject={place?.label || th.root.quote}
                active={open}
                lit={id === litThread}
                compact={!open}
                askReply={replyAsked?.thread === id ? replyAsked.n : 0}
                onOpen={open ? undefined : () => pageUi.openThread(id, true)}
                onLeave={open ? pageUi.leaveThread : undefined}
                onResolved={() => {
                  pageUi.leaveThread();
                  backToText();
                }}
              />
            ) : (
              <div className="rounded-lg border border-accent bg-surface p-2">
                <Composer
                  ref={draftBox}
                  placeholder={t(draftWords ? "docs.comment.placeholderWords" : "docs.comment.placeholder")}
                  submitLabel={t("docs.comment.send")}
                  onCancel={() => {
                    pageUi.endDraft();
                    backToText();
                  }}
                  onSubmit={(comment) => {
                    if (draft) addComment({ docId, blockId: draft, words: draftWords ?? undefined, ...comment });
                    pageUi.endDraft();
                    backToText();
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}

/** Where words of a thread are in the text, and what they read; none when they are not there. */
function wordsIn(column: HTMLElement, thread: string) {
  const marked = column.querySelectorAll<HTMLElement>(
    `.qd-editor [data-style-type="comment"][data-value~="${CSS.escape(thread)}"]`,
  );
  const first = marked[0];
  if (!first) return undefined;
  return { top: shownTop(first), label: [...marked].map((el) => el.textContent).join("") };
}

/** Where a block is in the text, and what it reads; none when it is not there. */
function blockIn(column: HTMLElement, block: string) {
  const outer = column.querySelector<HTMLElement>(`.qd-editor .bn-block-outer[data-id="${CSS.escape(block)}"]`);
  if (!outer) return undefined;
  return {
    top: shownTop(outer),
    label: outer.querySelector(":scope > .bn-block > .bn-block-content")?.textContent ?? "",
  };
}

/** How far down the screen something is; for something folded away (in a closed toggle), the block around it that shows. */
function shownTop(el: Element): number {
  let shown: Element | null = el;
  while (shown && shown.getClientRects().length === 0) shown = shown.parentElement?.closest(".bn-block-outer") ?? null;
  return (shown ?? el).getBoundingClientRect().top;
}
