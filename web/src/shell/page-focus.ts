// Who has the keyboard after going somewhere. A click in the sidebar leaves
// the browser's focus on the link that was clicked, and the palette gives it
// back to whatever had it before; the next key (J in a list) then draws a
// focus ring on that link, as if the sidebar were being driven. So after
// every move to another page the focus is put on the page itself: the keys
// are the page's, Tab goes on from its first control, and nothing outside
// the page looks focused. The lists mark their current row themselves
// (a styled row, not the browser's focus), so one thing looks focused.

import { useEffect, useRef } from "react";

/**
 * Where the focus is left alone: inside something open over the page (it
 * gives the focus back itself when it closes), in the task panel, and on a
 * row of the docs tree, which is driven with the arrow keys from where it
 * was clicked.
 */
const KEEPS_FOCUS = '[role="dialog"], [role="menu"], [role="listbox"], [data-task-panel], [data-tree-row]';

const page = () => document.querySelector<HTMLElement>("main[data-page]");

/** Puts the focus on the page, unless it is already in it or somewhere that keeps it. */
export function focusPage() {
  const main = page();
  const active = document.activeElement;
  if (!main || main.contains(active)) return;
  if (active instanceof HTMLElement && active.closest(KEEPS_FOCUS)) return;
  main.focus({ preventScroll: true });
}

/** Does so after each move in the browser's history (`step` is its name), not when the app first opens. */
export function usePageFocus(step: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else focusPage();
  }, [step]);
}
