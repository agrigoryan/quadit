// Where a list was left: how far it was scrolled, which row the keyboard
// was on, which groups were folded. Kept per step of the browser's history,
// so coming back to a list (Back, or Escape on a task's page) finds it as
// it was, and arriving at it afresh starts at the top. It is kept in the
// tab's own storage, so a reload finds it too.

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

export interface Place {
  top: number;
  /** Sideways, for what scrolls that way (a board's columns). */
  left?: number;
  /** The id of the row the keyboard was on. */
  focus: string | null;
  /** The ids of the groups that were folded. */
  folded?: string[];
}

const STORE = "quadit.places";
/** As many as anyone goes back through; the oldest give way. */
const KEPT = 80;

function stored(): [string, Place][] {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(STORE) ?? "[]");
    return Array.isArray(kept) ? (kept as [string, Place][]) : [];
  } catch {
    return []; // storage turned off, or not ours: start with nothing kept
  }
}

const places = new Map<string, Place>(stored());

function keep(name: string, place: Place) {
  places.delete(name);
  places.set(name, place);
  while (places.size > KEPT) places.delete(places.keys().next().value as string);
  try {
    sessionStorage.setItem(STORE, JSON.stringify([...places]));
  } catch {
    // Private mode or a full store: the place lasts until the page is reloaded.
  }
}

/**
 * The router names every step of the history it makes, but the step the tab
 * was opened at it calls "default", every time. Places are kept by a step's
 * name and outlive a reload, so that step needs a name of its own, or a
 * list opened afresh would be scrolled to where another was left. This
 * gives it one, in the same field of the history's state the router reads
 * its names from; call it before the router starts. A reload keeps it.
 */
export function nameFirstStep() {
  const state = window.history.state as { key?: string } | null;
  if (state?.key && state.key !== "default") return;
  window.history.replaceState({ ...state, key: Math.random().toString(36).slice(2, 10) }, "");
}

/**
 * Returns the place this list was left at on this step of the history, if
 * it was here before, and scrolls `scroller` back to it. `now` says where
 * the list is at present; it is asked when the list leaves the screen or
 * the page is reloaded. A page with several scrolling parts (a board and
 * each of its columns) names each one with `part`.
 */
export function usePlace(scroller: RefObject<HTMLElement | null>, now: () => Omit<Place, "top" | "left">, part = ""): Place | undefined {
  const step = useLocation().key;
  const name = part ? `${step}#${part}` : step;
  const [saved] = useState(() => places.get(name));
  const latest = useRef(now);
  latest.current = now;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!saved || !el) return;
    el.scrollTop = saved.top;
    if (saved.left) el.scrollLeft = saved.left;
  }, [saved, scroller]);

  // A layout effect is undone while the list's element is still on the page, so it can still be asked where it is scrolled to.
  useLayoutEffect(() => {
    const save = () => {
      const el = scroller.current;
      if (el) keep(name, { top: el.scrollTop, left: el.scrollLeft || undefined, ...latest.current() });
    };
    return save;
  }, [name, scroller]);

  // A reload ends the page without taking it off the screen first.
  useEffect(() => {
    const save = () => {
      const el = scroller.current;
      if (el) keep(name, { top: el.scrollTop, left: el.scrollLeft || undefined, ...latest.current() });
    };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [name, scroller]);

  return saved;
}
