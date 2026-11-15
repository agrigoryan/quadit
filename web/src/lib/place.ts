// Where a list was left: how far it was scrolled, which row the keyboard
// was on, which groups were folded. Kept per step of the browser's history,
// so coming back to a list (Back, or Escape on a task's page) finds it as
// it was, and arriving at it afresh starts at the top.

import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

export interface Place {
  top: number;
  /** The id of the row the keyboard was on. */
  focus: string | null;
  /** The ids of the groups that were folded. */
  folded?: string[];
}

/** As many as anyone goes back through; the oldest give way. */
const KEPT = 60;
const places = new Map<string, Place>();

function keep(step: string, place: Place) {
  places.delete(step);
  places.set(step, place);
  if (places.size > KEPT) places.delete(places.keys().next().value as string);
}

/**
 * Returns the place this list was left at on this step of the history, if
 * it was here before, and scrolls `scroller` back to it. `now` says where
 * the list is at present; it is asked when the list leaves the screen.
 */
export function usePlace(scroller: RefObject<HTMLElement | null>, now: () => Omit<Place, "top">): Place | undefined {
  const step = useLocation().key;
  const [saved] = useState(() => places.get(step));
  const latest = useRef(now);
  latest.current = now;

  useLayoutEffect(() => {
    if (saved && scroller.current) scroller.current.scrollTop = saved.top;
  }, [saved, scroller]);

  // A layout effect is undone while the list's element is still on the page, so it can still be asked where it is scrolled to.
  useLayoutEffect(() => () => keep(step, { top: scroller.current?.scrollTop ?? 0, ...latest.current() }), [step, scroller]);
  return saved;
}
