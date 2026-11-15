// The row of the task list the keyboard is on: moving it, keeping it in
// view, and finding it again. Left for a task's page and come back to, the
// list has its folded groups and its current row back (lib/place.ts), and
// a page that stepped on to other tasks leaves the current row on the last
// of them (lib/task-queue.ts). The panel follows the current row while it
// is open, and the current row follows the panel when it goes to another
// task by other means.

import { type RefObject, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { usePlace } from "@/lib/place";
import { isDraft } from "@/lib/store";
import { usePeek, useTaskNav } from "@/lib/task-link";
import { takeSeen, useTaskOrder } from "@/lib/task-queue";
import type { Task } from "@/lib/types";
import type { TaskGroup } from "@/tasks/filters";
import { type ListLayout, ROW, type Row, rowPlace, stepFrom } from "@/tasks/list-layout";

/** What the list keeps when it is left: which groups are folded, and the key of the row the keyboard is on. */
export interface ListPlace {
  folded: Set<string>;
  toggleFolded: (group: TaskGroup) => void;
  focusKey: string | null;
  setFocusKey: (key: string | null) => void;
}

export function useListPlace(scroller: RefObject<HTMLElement | null>): ListPlace {
  const place = useRef({ focus: null as string | null, folded: [] as string[] });
  const saved = usePlace(scroller, () => place.current);
  const [folded, setFolded] = useState<Set<string>>(() => new Set(saved?.folded));
  const [focusKey, setFocusKey] = useState<string | null>(saved?.focus ?? null);
  place.current = { focus: focusKey, folded: [...folded] };
  const toggleFolded = useCallback(
    (group: TaskGroup) =>
      setFolded((prev) => {
        const next = new Set(prev);
        if (!next.delete(group.id)) next.add(group.id);
        return next;
      }),
    [],
  );
  return { folded, toggleFolded, focusKey, setFocusKey };
}

export interface ListFocus {
  /** Where the current row is among the rows showing; -1 for none. */
  focusAt: number;
  /** The task of the current row. */
  focused: Task | undefined;
  /** Moves the current row `step` rows on (from `from`, else from where it is), into view. Returns the row moved to. */
  move: (step: number, from?: number) => Row | undefined;
  /** Opens the task in the panel. */
  showInPanel: (task: Task) => void;
  /** Moves the panel a row along. The current row leads and the panel follows, so keys pressed quickly are all counted. */
  stepPanel: (step: number) => void;
}

export function useListFocus(
  { rows, indexOf, sections }: ListLayout,
  { focusKey, setFocusKey }: ListPlace,
  scrollerRef: RefObject<HTMLElement | null>,
): ListFocus {
  const open = useTaskNav();
  const peek = usePeek();
  const focusAt = focusKey === null ? -1 : (indexOf.get(focusKey) ?? -1);
  const focused = rows[focusAt]?.task;

  /** Makes the row at this position the current one, and scrolls just far enough that it is in view, clear of its sticky heading. */
  function focusRow(index: number) {
    setFocusKey(rows[index]?.key ?? null);
    const el = scrollerRef.current;
    const place = rowPlace(sections, index);
    if (!el || !place) return;
    if (place.top < el.scrollTop + place.head) el.scrollTop = place.top - place.head;
    else if (place.top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = place.top + ROW - el.clientHeight;
  }

  function move(step: number, from = focusAt): Row | undefined {
    if (rows.length === 0) return undefined;
    const at = stepFrom(from, step, rows.length);
    const next = rows[at];
    if (next) focusRow(at);
    return next;
  }

  // A task's page opened from here steps along these rows. Come back to from
  // a page that stepped on, the current row is the task it ended at.
  const listStep = useTaskOrder(() => rows.map((row) => row.task.key));
  const focusSeen = useEffectEvent((step: string) => {
    const key = takeSeen(step);
    const at = key ? rows.findIndex((row) => row.task.key === key) : -1;
    if (at >= 0) focusRow(at);
  });
  useLayoutEffect(() => focusSeen(listStep), [listStep]);

  /** Where the task in the panel is listed, when the current row is not on it. */
  const peekedAt = focused?.key === peek.key ? focusAt : rows.findIndex((row) => row.task.key === peek.key);
  /** The tasks this list asked the panel for, so their arrival is not taken for a move made elsewhere. */
  const asked = useRef(new Set<string>());

  function showInPanel(task: Task) {
    // A row not yet numbered by the server has nothing to show.
    if (isDraft(task.id)) return;
    asked.current.add(task.key);
    open.peek(task.key);
  }

  function stepPanel(step: number) {
    const next = move(step, focusAt < 0 ? peekedAt : focusAt);
    if (next) showInPanel(next.task);
  }

  // The panel went to another task by other means (a sub-task opened inside it): the current row goes with it.
  const followPanel = useEffectEvent((key: string | undefined) => {
    if (key === undefined) {
      asked.current.clear();
      return;
    }
    if (asked.current.delete(key) || peekedAt < 0 || peekedAt === focusAt) return;
    focusRow(peekedAt);
  });
  useEffect(() => followPanel(peek.key), [peek.key]);

  return { focusAt, focused, move, showInPanel, stepPanel };
}
