// Keyboard focus for a page that is one flat run of rows: J and K move it,
// Enter opens the row it is on. The focus follows a row by its id, so rows
// arriving or leaving while the page is open do not move it.

import { useEffect, useRef, useState } from "react";
import { type Hotkeys, useHotkeys } from "@/lib/hotkeys";

/** True while a task panel covers the page: its rows then leave the keys alone. */
const panelOpen = () => /\/task\/[^/]+\/?$/.test(window.location.pathname);

/** A focused link or button answers Enter itself. */
const onControl = (e: KeyboardEvent) => e.target instanceof HTMLElement && e.target.closest("a, button") !== null;

interface Options<Row> {
  rows: Row[];
  idOf: (row: Row) => string;
  onOpen: (row: Row) => void;
  /** More keys that act on the focused row ("e" archives it). */
  keys?: Record<string, (row: Row) => void>;
}

/** Returns the id of the focused row, or null before the keyboard is used. */
export function useListKeys<Row>({ rows, idOf, onOpen, keys = {} }: Options<Row>): string | null {
  const [focusId, setFocusId] = useState<string | null>(null);
  const lastIndex = useRef(-1);

  let index = focusId === null ? -1 : rows.findIndex((row) => idOf(row) === focusId);
  // The focused row left the list (archived, answered): stay where it was.
  if (focusId !== null && index < 0 && rows.length > 0) index = Math.min(Math.max(lastIndex.current, 0), rows.length - 1);
  lastIndex.current = index;
  const current = rows[index];
  const currentId = current ? idOf(current) : null;

  const move = (by: number) => {
    const next = rows[Math.min(Math.max(index + by, 0), rows.length - 1)];
    if (!next) return;
    setFocusId(idOf(next));
    // One marker at a time: a row left focused by the mouse or Tab gives way.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("main")) active.blur();
  };

  const hotkeys: Hotkeys = {
    j: () => !panelOpen() && move(1),
    k: () => !panelOpen() && move(index < 0 ? 1 : -1),
    Enter: (e) => {
      if (!current || panelOpen() || onControl(e)) return;
      e.preventDefault();
      onOpen(current);
    },
  };
  for (const [key, run] of Object.entries(keys)) {
    hotkeys[key] = () => {
      if (current && !panelOpen()) run(current);
    };
  }
  useHotkeys(hotkeys);

  useEffect(() => {
    if (currentId) document.querySelector("main [data-focused]")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  return currentId;
}
