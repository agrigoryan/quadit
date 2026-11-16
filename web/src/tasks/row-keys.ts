// The keys of a page that lists tasks as one flat run of rows, as the task
// list has them (tasks/task-list.tsx): J and K or the arrows move, Space
// and Enter open (tasks/list-keys.ts), X selects and Cmd+A selects every
// row, Escape lets go of the selection, and the keys of tasks/task-keys.tsx
// act on the selection, or else on the focused row. An epic's page and a
// cycle's page list their tasks so.

import { type ReactElement, type RefObject, useCallback, useMemo, useRef, useState } from "react";
import { useHotkeys } from "@/hooks/hotkeys";
import { useTaskNav } from "@/nav/task-link";
import type { Task } from "@/types/core";
import { useListKeys } from "@/tasks/list-keys";
import { useTaskKeys } from "@/tasks/task-keys";

interface TaskRowKeys {
  /** What a row needs to show the keys' state, and its box to select it: spread them on its TaskRow. */
  rowProps: (task: Task) => {
    focused: boolean;
    selected: boolean;
    onSelect: (task: Task, range: boolean) => void;
  };
  /** The tasks selected, in the page's order: for the bulk bar. */
  selected: Task[];
  /** Lets go of the selection. */
  clear: () => void;
  /** The property picker a key opened, to draw. */
  picker: ReactElement | null;
}

/** Binds the keys for `tasks`, in the order the page shows them, in the element `scroller` scrolls. */
export function useTaskRowKeys(tasks: Task[], scroller: RefObject<HTMLElement | null>): TaskRowKeys {
  const open = useTaskNav();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const lastPicked = useRef<string | null>(null);
  // A task that left the page (moved to another epic, finished elsewhere) is no longer selected.
  const selected = useMemo(() => tasks.filter((task) => selectedIds.has(task.id)), [tasks, selectedIds]);

  /** Picks a task, or takes it back; with Shift every task from the one picked last. */
  const select = useCallback(
    (task: Task, range: boolean) => {
      const from = tasks.findIndex((tk) => tk.id === lastPicked.current);
      const to = tasks.findIndex((tk) => tk.id === task.id);
      lastPicked.current = task.id;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (range && from >= 0 && to >= 0)
          for (const tk of tasks.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(tk.id);
        else if (!next.delete(task.id)) next.add(task.id);
        return next;
      });
    },
    [tasks],
  );
  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const focusId = useListKeys({
    rows: tasks,
    idOf: (task) => task.id,
    onOpen: (task, as) => open[as](task.key),
    taskKeyOf: (task) => task.key,
    scroller,
    keys: { x: (task) => select(task, false) },
  });
  useHotkeys({ Escape: clear }, { enabled: selected.length > 0 });
  useHotkeys(
    {
      // Every task of the page, not the text of the page, as the browser would.
      "mod+a": (e) => {
        e.preventDefault();
        setSelectedIds(new Set(tasks.map((task) => task.id)));
      },
    },
    { guardChords: true },
  );
  const picker = useTaskKeys({
    tasksFor: () => (selected.length > 0 ? selected : tasks.filter((task) => task.id === focusId)),
    // The row may be out of view; the page's scroller then holds the picker.
    anchorFor: ([first]) =>
      (first && scroller.current?.querySelector(`[data-task="${CSS.escape(first.id)}"]`)) || scroller.current,
  });

  return {
    rowProps: (task) => ({ focused: task.id === focusId, selected: selectedIds.has(task.id), onSelect: select }),
    selected,
    clear,
    picker,
  };
}
