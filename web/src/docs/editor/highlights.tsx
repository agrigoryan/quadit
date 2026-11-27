// The words of the page's open comment threads, highlighted where the
// editor shows them. Each run of words names its threads in its style's
// value (editor/schema.tsx); a resolved thread keeps its marker and is not
// highlighted, so opening it again brings the highlight back. A click on
// highlighted words shows their thread; the pointer on them lights it, here
// and in the margin or the comments column; the words of the thread shown
// are highlighted strongest. The colours are theme.css's.

import { useEffect, useRef } from "react";
import type { AnyEditor } from "@/docs/editor/sync";
import { threadsIn } from "@/docs/editor/words";

interface Props {
  editor: AnyEditor;
  /** The open threads on words, the ones highlighted. */
  open: string[];
  /** The thread the pointer is on, here or beside the text. */
  lit?: string | null;
  /** The thread shown, in the margin or the column. */
  active?: string | null;
  onShow?: (threadId: string) => void;
  onLight?: (threadId: string | null) => void;
}

/** The words a style value names, as a selector; ids are the server's (letters, digits, dashes). */
const wordsOf = (id: string) => `.qd-editor [data-style-type="comment"][data-value~="${id}"]`;
const safe = (id: string) => /^[\w-]+$/.test(id);

export function Highlights({ editor, open, lit, active, onShow, onLight }: Props) {
  // What the listeners below read when the pointer moves: the props of the last render.
  const latest = useRef({ open, onShow, onLight });
  useEffect(() => {
    latest.current = { open, onShow, onLight };
  });

  useEffect(() => {
    const dom = editor.domElement;
    if (!dom) return;
    /** The open threads on the words under the pointer, first of the page's order. */
    const threadsAt = (target: EventTarget | null): string[] => {
      const marked = target instanceof Element ? target.closest('[data-style-type="comment"]') : null;
      const here = threadsIn(marked?.getAttribute("data-value"));
      return latest.current.open.filter((id) => here.includes(id));
    };
    const onClick = (e: MouseEvent) => {
      const [thread] = threadsAt(e.target);
      if (thread) latest.current.onShow?.(thread);
    };
    const onOver = (e: MouseEvent) => latest.current.onLight?.(threadsAt(e.target)[0] ?? null);
    const onLeave = () => latest.current.onLight?.(null);
    dom.addEventListener("click", onClick);
    dom.addEventListener("mouseover", onOver);
    dom.addEventListener("mouseleave", onLeave);
    return () => {
      dom.removeEventListener("click", onClick);
      dom.removeEventListener("mouseover", onOver);
      dom.removeEventListener("mouseleave", onLeave);
    };
  }, [editor]);

  const shown = open.filter(safe);
  if (shown.length === 0) return null;
  let css = `${shown.map(wordsOf).join(",")}{background:var(--qd-comment);border-bottom:2px solid var(--move);cursor:pointer}`;
  if (lit && shown.includes(lit)) css += `${wordsOf(lit)}{background:var(--qd-comment-lit)}`;
  if (active && shown.includes(active))
    css += `${wordsOf(active)}{background:var(--qd-comment-active)}${wordsOf(active)},${wordsOf(active)} *{color:var(--qd-comment-active-ink)}`;
  return <style>{css}</style>;
}
