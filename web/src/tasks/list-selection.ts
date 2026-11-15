// The tasks picked in the task list for changing together (the bulk bar,
// and S/A/P/L on the keyboard). The page holds the selection; this picks
// rows into it, one at a time or a range with Shift, and drops what is no
// longer listed.

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Task } from "@/lib/types";
import type { ListLayout } from "@/tasks/list-layout";

export interface ListSelection {
  /** What a change made from the keyboard applies to: the selected tasks, else the current row's. */
  targets: Task[];
  /** Picks a task or puts it back; with `range`, every row from the last one picked. `at` names the row. */
  select: (task: Task, range: boolean, at?: string) => void;
}

export function useListSelection(
  { rows, indexOf }: ListLayout,
  focused: Task | undefined,
  selected: Set<string>,
  onSelectedChange: (next: Set<string>) => void,
): ListSelection {
  const lastPicked = useRef<string | null>(null);

  const targets = useMemo(() => {
    if (selected.size === 0) return focused ? [focused] : [];
    // Grouped by label a task can show twice; it is changed once.
    const picked = new Map<string, Task>();
    for (const row of rows) if (selected.has(row.task.id)) picked.set(row.task.id, row.task);
    return [...picked.values()];
  }, [rows, selected, focused]);

  // A selection only ever holds rows that are still on screen.
  useEffect(() => {
    if (selected.size === 0) return;
    const ids = new Set(rows.map((row) => row.task.id));
    const kept = [...selected].filter((id) => ids.has(id));
    if (kept.length !== selected.size) onSelectedChange(new Set(kept));
  }, [rows, selected, onSelectedChange]);

  const select = useCallback(
    (task: Task, range: boolean, at?: string) => {
      const key = at ?? task.id;
      const next = new Set(selected);
      const from = lastPicked.current;
      const a = from ? indexOf.get(from) : undefined;
      const b = indexOf.get(key);
      if (range && a !== undefined && b !== undefined) {
        for (const row of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(row.task.id);
      } else if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      lastPicked.current = key;
      onSelectedChange(next);
    },
    [selected, rows, indexOf, onSelectedChange],
  );

  return { targets, select };
}
