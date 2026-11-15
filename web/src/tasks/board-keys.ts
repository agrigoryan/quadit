// The board's keys for looking at tasks. A board has no row the keyboard
// is "on", so the card the keys mean is the one that has the focus (clicked,
// or reached with Tab), else the one under the pointer: Space shows it in
// the panel and puts the panel away again, Enter opens its page. While the
// panel is open, J and K (or the arrows) move it down and up the column,
// and the left and right arrows to the column beside it. Space being the
// quick look, a card is lifted for moving with Shift+Space (tasks/board.tsx).

import { type MouseEvent, type RefObject, useEffect, useEffectEvent, useRef } from "react";
import { useHotkeys } from "@/lib/hotkeys";
import { usePlace } from "@/lib/place";
import { isDraft } from "@/data/store";
import type { Task } from "@/types/core";
import type { TaskGroup } from "@/tasks/filters";
import { usePeek, useTaskNav } from "@/lib/task-link";
import { takeSeen, useTaskOrder } from "@/lib/task-queue";
import { isOnControl, usePanelStepKeys } from "@/tasks/panel-keys";

/** The id of the task whose card has the focus. */
const focusedCard = (e: KeyboardEvent) =>
  e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-task]")?.dataset.task : undefined;

/** The card of a task, where it is drawn. */
const cardOf = (id: string) => document.querySelector<HTMLElement>(`main a[data-task="${CSS.escape(id)}"]`);
const focusedId = () =>
  document.activeElement instanceof HTMLElement
    ? (document.activeElement.closest<HTMLElement>("[data-task]")?.dataset.task ?? null)
    : null;

/**
 * Puts the focus on a task's card once it is drawn: a column draws its
 * cards a moment after it is on the page. It gives up if the person has
 * meanwhile put the focus somewhere themselves.
 */
function focusCard(id: string, keepScroll: boolean, tries = 20) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active.tagName !== "MAIN") return;
  const card = cardOf(id);
  if (card) card.focus({ preventScroll: keepScroll });
  else if (tries > 0) setTimeout(() => focusCard(id, keepScroll, tries - 1), 50);
}

/**
 * Give the returned handlers to the element that holds the columns, whose
 * ref is `scroller`. Left for a task's page and come back to, the board is
 * scrolled where it was with the focus on the card that was opened
 * (lib/place.ts; each column keeps its own scroll in tasks/board-column.tsx).
 */
export function useBoardKeys(groups: TaskGroup[], scroller: RefObject<HTMLElement | null>) {
  const open = useTaskNav();
  const peek = usePeek();
  const hoveredId = useRef<string | null>(null);

  const saved = usePlace(scroller, () => ({ focus: focusedId() }));
  // A task's page opened from here steps down each column in turn; come back to from one that stepped on, the focus is on the task it ended at.
  const boardStep = useTaskOrder(() => groups.flatMap((g) => g.tasks.map((tk) => tk.key)));
  const focusSeen = useEffectEvent((step: string) => {
    const key = takeSeen(step);
    const seen = key ? groups.flatMap((g) => g.tasks).find((tk) => tk.key === key)?.id : undefined;
    const id = seen ?? saved?.focus;
    if (id) focusCard(id, !seen);
  });
  useEffect(() => focusSeen(boardStep), [boardStep]);

  /** The task a key means: the card with the focus, else the one under the pointer. */
  const meant = (e: KeyboardEvent): Task | undefined => {
    const id = focusedCard(e) ?? hoveredId.current;
    if (!id || isDraft(id)) return undefined;
    for (const group of groups) {
      const task = group.tasks.find((tk) => tk.id === id);
      if (task) return task;
    }
    return undefined;
  };

  useHotkeys({
    " ": (e) => {
      const task = meant(e);
      if (!task || isOnControl(e)) return;
      e.preventDefault();
      open.peek(task.key);
    },
    Enter: (e) => {
      const task = meant(e);
      if (!task || isOnControl(e)) return;
      e.preventDefault();
      // The card opened is the one to come back to.
      cardOf(task.id)?.focus({ preventScroll: true });
      open.page(task.key);
    },
  });

  /** Moves the panel within its column (`down`), or to the same height in a column beside it (`across`). */
  const step = (down: number, across: number) => {
    const col = groups.findIndex((g) => g.tasks.some((tk) => tk.key === peek.key));
    const row = groups[col]?.tasks.findIndex((tk) => tk.key === peek.key) ?? -1;
    if (col < 0 || row < 0) return;
    let to = col + across;
    // Past the columns with nothing in them.
    while (across !== 0 && groups[to] && groups[to]?.tasks.length === 0) to += across;
    const tasks = groups[to]?.tasks ?? [];
    const next = tasks[Math.min(Math.max(row + down, 0), tasks.length - 1)];
    if (next && next.key !== peek.key && !isDraft(next.id)) open.peek(next.key);
  };
  usePanelStepKeys({
    onStep: (by) => step(by, 0),
    onStepAcross: (by) => step(0, by),
    // On another card than the one in the panel, Space shows that one; on the same, or on none, it puts the panel away.
    onSpace: (e) => {
      const task = meant(e);
      if (task && task.key !== peek.key) open.peek(task.key);
      else peek.close();
    },
  });

  return {
    onMouseOver: (e: MouseEvent) => {
      hoveredId.current = (e.target as HTMLElement).closest<HTMLElement>("[data-task]")?.dataset.task ?? null;
    },
    onMouseLeave: () => {
      hoveredId.current = null;
    },
  };
}
