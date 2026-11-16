// The board's keys for looking at tasks. A board has no row the keyboard
// is "on", so the card the keys mean is the one that has the focus (clicked,
// reached with Tab or with the keys below), else the one under the pointer:
// J and K or the arrows move the focus down and up the column, and the left
// and right arrows to the column beside; Space shows the card in the panel
// and puts the panel away again, Enter opens its page, and the keys of
// tasks/task-keys.tsx (S/A/P/L, I, the copy keys, Cmd+Backspace) act on it.
// While the panel is open the same keys move the panel instead. Space
// being the quick look, a card is lifted for moving with Shift+Space
// (tasks/board.tsx), and while it is lifted the arrows are the lift's.

import { type MouseEvent, type RefObject, useEffect, useEffectEvent, useRef } from "react";
import { useHotkeys } from "@/hooks/hotkeys";
import { usePlace } from "@/nav/place";
import { isDraft } from "@/data/store";
import type { Task } from "@/types/core";
import type { TaskGroup } from "@/tasks/filters";
import { usePeek, useTaskNav } from "@/nav/task-link";
import { takeSeen, useTaskOrder } from "@/nav/task-queue";
import { isOnControl, usePanelStepKeys } from "@/tasks/panel-keys";
import { useTaskKeys } from "@/tasks/task-keys";

/** The id of the task whose card has the focus. */
const focusedCard = (e: KeyboardEvent) =>
  e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-task]")?.dataset.task : undefined;

/** The link of a task's card, where it is drawn: on the board it is what has the focus. */
const cardOf = (id: string) => document.querySelector<HTMLElement>(`main a[data-task="${CSS.escape(id)}"]`);
/** The element of a column, by its group's id: board.tsx marks each with data-column. */
const columnOf = (id: string) => document.querySelector<HTMLElement>(`main [data-column="${CSS.escape(id)}"]`);

/** Puts the focus on a card drawn on the board, and scrolls its column and the board just far enough to show it. */
function focusOn(card: HTMLElement) {
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: "nearest", inline: "nearest" });
}
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
 * ref is `scroller`, and draw the returned picker (opened by S, A, P, L). Left for a task's page and come back to, the board is
 * scrolled where it was with the focus on the card that was opened
 * (nav/place.ts; each column keeps its own scroll in tasks/board-column.tsx).
 */
export function useBoardKeys(groups: TaskGroup[], scroller: RefObject<HTMLElement | null>, lifted: boolean) {
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

  /**
   * Moves the focus from the card it is on (else the one under the pointer)
   * to the next one down the column (`down`), or to the card nearest the
   * same height in the column beside (`across`), past columns with nothing
   * in them. With no card to start from, it goes to the first card.
   */
  const walk = (down: number, across: number) => (e: KeyboardEvent) => {
    e.preventDefault(); // or the board scrolls
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fromId = focusedId() ?? hoveredId.current;
    // A task grouped by label can have a card in two columns: the one with the focus is the one meant.
    const fromColumn = active?.closest<HTMLElement>("[data-column]")?.dataset.column;
    const col = groups.findIndex(
      (g) => (fromColumn === undefined || g.id === fromColumn) && g.tasks.some((tk) => tk.id === fromId),
    );
    const row = groups[col]?.tasks.findIndex((tk) => tk.id === fromId) ?? -1;
    if (col < 0 || row < 0) {
      const first = groups.find((g) => g.tasks.length > 0);
      const card = first?.tasks[0] && columnOf(first.id)?.querySelector<HTMLElement>("a[data-task]");
      if (card) focusOn(card);
      return;
    }
    let to = col + across;
    while (across !== 0 && groups[to]?.tasks.length === 0) to += across;
    const group = groups[to];
    const column = group && columnOf(group.id);
    if (!group || !column) return;
    if (across === 0) {
      const next = group.tasks[Math.min(Math.max(row + down, 0), group.tasks.length - 1)];
      const card = next && column.querySelector<HTMLElement>(`a[data-task="${CSS.escape(next.id)}"]`);
      if (card) focusOn(card);
      return;
    }
    // Only the cards in view are drawn, so the one at the same height is found among them.
    const from = active?.closest<HTMLElement>("[data-task]") ?? (fromId === null ? null : cardOf(fromId));
    const top = from?.getBoundingClientRect().top ?? 0;
    const distance = (card: HTMLElement) => Math.abs(card.getBoundingClientRect().top - top);
    const nearest = [...column.querySelectorAll<HTMLElement>("a[data-task]")].reduce<HTMLElement | undefined>(
      (best, card) => (!best || distance(card) < distance(best) ? card : best),
      undefined,
    );
    if (nearest) focusOn(nearest);
  };
  useHotkeys(
    {
      j: walk(1, 0),
      k: walk(-1, 0),
      ArrowDown: walk(1, 0),
      ArrowUp: walk(-1, 0),
      ArrowRight: walk(0, 1),
      ArrowLeft: walk(0, -1),
    },
    { enabled: !lifted },
  );

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

  // S/A/P/L, I, the copy keys and Cmd+Backspace act on the card the keys mean.
  const picker = useTaskKeys({
    tasksFor: (e) => {
      const task = meant(e);
      return task ? [task] : [];
    },
    anchorFor: ([first]) => (first ? cardOf(first.id) : null),
  });

  return {
    picker,
    handlers: {
      onMouseOver: (e: MouseEvent) => {
        hoveredId.current = (e.target as HTMLElement).closest<HTMLElement>("[data-task]")?.dataset.task ?? null;
      },
      onMouseLeave: () => {
        hoveredId.current = null;
      },
    },
  };
}
