// Keyboard focus for a page that is one flat run of rows: J and K move it,
// Space shows the row's task in the panel, Enter opens the task's page.
// While the panel is open J and K move it along the rows, and Space puts it
// away. The focus follows a row by its id, so rows arriving or leaving
// while the page is open do not move it; left and come back to, the page is
// where it was (lib/place.ts).

import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { type Hotkeys, useHotkeys } from "@/lib/hotkeys";
import { usePlace } from "@/lib/place";
import { takeSeen, useTaskOrder } from "@/lib/task-queue";
import { isOnControl, usePanelStepKeys } from "@/tasks/panel-keys";

/** How a row is opened: in the panel over the list, or as the task's own page. */
export type OpenAs = "peek" | "page";

interface Options<Row> {
  rows: Row[];
  idOf: (row: Row) => string;
  onOpen: (row: Row, as: OpenAs) => void;
  /** The key of the task a row opens. A task's page opened from here steps along the rows by it. */
  taskKeyOf: (row: Row) => string | undefined;
  /** The element that scrolls the rows. */
  scroller: RefObject<HTMLElement | null>;
  /** More keys that act on the focused row ("e" archives it). */
  keys?: Record<string, (row: Row) => void>;
}

/** Returns the id of the focused row, or null before the keyboard is used. */
export function useListKeys<Row>({ rows, idOf, onOpen, taskKeyOf, scroller, keys = {} }: Options<Row>): string | null {
  const place = useRef<{ focus: string | null }>({ focus: null });
  const saved = usePlace(scroller, () => place.current);
  const [focusId, setFocusId] = useState<string | null>(saved?.focus ?? null);
  place.current = { focus: focusId };
  const lastIndex = useRef(-1);

  // Come back to from a task's page that stepped on to another task, the focus is on the task it ended at.
  const listStep = useTaskOrder(() => rows.map(taskKeyOf));
  const focusSeen = useEffectEvent((step: string) => {
    const key = takeSeen(step);
    const row = key ? rows.find((r) => taskKeyOf(r) === key) : undefined;
    if (row) setFocusId(idOf(row));
  });
  useLayoutEffect(() => focusSeen(listStep), [listStep]);

  let index = focusId === null ? -1 : rows.findIndex((row) => idOf(row) === focusId);
  // The focused row left the list (archived, answered): stay where it was.
  if (focusId !== null && index < 0 && rows.length > 0)
    index = Math.min(Math.max(lastIndex.current, 0), rows.length - 1);
  lastIndex.current = index;
  const current = rows[index];
  const currentId = current ? idOf(current) : null;

  const move = (by: number): Row | undefined => {
    const next = rows[Math.min(Math.max(index + by, 0), rows.length - 1)];
    if (!next) return;
    setFocusId(idOf(next));
    // One marker at a time: a row left focused by the mouse or Tab gives way. The focus stays in the page, so Tab goes on from it.
    const active = document.activeElement;
    const main = active instanceof HTMLElement ? active.closest("main") : null;
    if (main && active !== main) main.focus({ preventScroll: true });
    return next;
  };

  const hotkeys: Hotkeys = {
    j: () => move(1),
    k: () => move(index < 0 ? 1 : -1),
    Enter: (e) => {
      if (!current || isOnControl(e)) return;
      e.preventDefault();
      onOpen(current, "page");
    },
    " ": (e) => {
      if (!current || isOnControl(e)) return;
      e.preventDefault();
      onOpen(current, "peek");
    },
  };
  for (const [key, run] of Object.entries(keys)) {
    hotkeys[key] = () => {
      if (current) run(current);
    };
  }
  useHotkeys(hotkeys);

  // While the panel is open the same keys move it to the next row.
  usePanelStepKeys({
    onStep: (by) => {
      const next = move(by);
      if (next && next !== current) onOpen(next, "peek");
    },
  });

  useEffect(() => {
    if (currentId) document.querySelector("main [data-focused]")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  return currentId;
}
