// Keyboard focus for a page that is one flat run of rows: J and K move it,
// Space shows the row's task in the panel, Enter opens the task's page.
// While the panel is open J and K move it along the rows, and Space puts it
// away. The focus follows a row by its id, so rows arriving or leaving
// while the page is open do not move it; left and come back to, the page is
// where it was (lib/place.ts).

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Hotkeys, useHotkeys } from "@/lib/hotkeys";
import { usePlace } from "@/lib/place";
import { usePeek } from "@/tasks/task-link";
import { takeSeen, useTaskOrder } from "@/tasks/task-queue";

/** A focused link or button answers Enter and Space itself. */
const onControl = (e: KeyboardEvent) => e.target instanceof HTMLElement && e.target.closest("a, button") !== null;
const onButton = (e: KeyboardEvent) => e.target instanceof HTMLElement && e.target.closest("button") !== null;

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
  const peek = usePeek();
  const peeking = peek.key !== undefined;
  const place = useRef<{ focus: string | null }>({ focus: null });
  const saved = usePlace(scroller, () => place.current);
  const [focusId, setFocusId] = useState<string | null>(saved?.focus ?? null);
  place.current = { focus: focusId };
  const lastIndex = useRef(-1);

  // Come back to from a task's page that stepped on to another task, the focus is on the task it ended at.
  const listStep = useTaskOrder(() => rows.map(taskKeyOf));
  useLayoutEffect(() => {
    const key = takeSeen(listStep);
    const row = key ? rows.find((r) => taskKeyOf(r) === key) : undefined;
    if (row) setFocusId(idOf(row));
  }, [listStep]);

  let index = focusId === null ? -1 : rows.findIndex((row) => idOf(row) === focusId);
  // The focused row left the list (archived, answered): stay where it was.
  if (focusId !== null && index < 0 && rows.length > 0) index = Math.min(Math.max(lastIndex.current, 0), rows.length - 1);
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
      if (!current || onControl(e)) return;
      e.preventDefault();
      onOpen(current, "page");
    },
    " ": (e) => {
      if (!current || onButton(e)) return;
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

  // The same keys while the panel is open: they move it to the next row, and Space puts it away.
  const step = (by: number) => (e: KeyboardEvent) => {
    e.preventDefault();
    const next = move(by);
    if (next && next !== current) onOpen(next, "peek");
  };
  useHotkeys(
    {
      j: step(1),
      k: step(-1),
      ArrowDown: step(1),
      ArrowUp: step(-1),
      " ": (e) => {
        if (onButton(e)) return;
        e.preventDefault();
        peek.close();
      },
    },
    { layer: "panel", enabled: peeking },
  );

  useEffect(() => {
    if (currentId) document.querySelector("main [data-focused]")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  return currentId;
}
