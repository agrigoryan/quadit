// What the lists of tasks (the task list, the board, the inbox and My work)
// share about their keys: when a key belongs to the control it was typed on
// rather than to the list, and the keys that act while the task panel is
// open over the list: J and K (and the arrows) step the panel to the next
// and previous task, Space puts it away. Escape is the panel's own
// (detail/task-view.tsx).

import { type Hotkeys, isTyping, useHotkeys } from "@/hooks/hotkeys";
import { usePeek } from "@/nav/task-link";

/** What answers Space itself: it presses a button and opens a summary. A link does not take Space. */
const ANSWERS_SPACE = "button, summary, [role=button], [role=menuitem]";
/** What answers Enter itself: links too. */
const ANSWERS_ENTER = `a, ${ANSWERS_SPACE}`;

/**
 * True when the key was typed into a field, or is Space or Enter on a
 * control that answers that key itself, so the list leaves it alone. A
 * task's own card or row (it carries data-task) is the list's: keys on it
 * are the list's keys.
 */
export function isOnControl(e: KeyboardEvent): boolean {
  if (isTyping(e.target)) return true;
  if (!(e.target instanceof Element)) return false;
  const control = e.target.closest(e.key === "Enter" ? ANSWERS_ENTER : ANSWERS_SPACE);
  return control !== null && !control.hasAttribute("data-task");
}

/**
 * J and K move the list's marker, not the browser's focus. A control of the
 * page left focused by the mouse or by Tab (a row's fold arrow, its status
 * button) would go on answering Space and Enter for a row the marker has
 * left, so the focus goes back to the page: the next key is the list's, and
 * Tab goes on from the page.
 */
export function giveKeysBackToList() {
  const active = document.activeElement;
  const main = active instanceof HTMLElement ? active.closest("main") : null;
  if (main && active !== main) main.focus({ preventScroll: true });
}

interface PanelStepKeys {
  /** Moves the panel along the list, `by` tasks down (or up, below zero). */
  onStep: (by: number) => void;
  /** Moves it to the column beside, `by` columns right (or left): the board's. Left out, the side arrows do nothing. */
  onStepAcross?: (by: number) => void;
  /** Space. Left out, it puts the panel away. */
  onSpace?: (e: KeyboardEvent) => void;
}

/** The keys that act while the task panel is open over the list. */
export function usePanelStepKeys({ onStep, onStepAcross, onSpace }: PanelStepKeys) {
  const peek = usePeek();
  const step = (move: (by: number) => void, by: number) => (e: KeyboardEvent) => {
    e.preventDefault();
    move(by);
  };
  const keys: Hotkeys = {
    j: step(onStep, 1),
    k: step(onStep, -1),
    ArrowDown: step(onStep, 1),
    ArrowUp: step(onStep, -1),
    " ": (e) => {
      if (isOnControl(e)) return;
      e.preventDefault();
      if (onSpace) onSpace(e);
      else peek.close();
    },
  };
  if (onStepAcross) {
    keys.ArrowRight = step(onStepAcross, 1);
    keys.ArrowLeft = step(onStepAcross, -1);
  }
  useHotkeys(keys, { layer: "panel", enabled: peek.key !== undefined });
}
