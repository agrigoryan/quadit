// The board's keys for looking at tasks. A board has no row the keyboard
// is "on", so the card under the pointer is the one the keys mean: Space
// shows it in the panel, Enter opens its page. While the panel is open, J
// and K (or the arrows) move it down and up the column, and the left and
// right arrows to the column beside it. A card that has the focus (reached
// with Tab) keeps Space for lifting it, as before.

import { type MouseEvent, useRef } from "react";
import { useHotkeys } from "@/lib/hotkeys";
import { isDraft } from "@/lib/store";
import type { Task } from "@/lib/types";
import type { TaskGroup } from "@/tasks/filters";
import { usePeek, useTaskNav } from "@/tasks/task-link";

/** A focused link or button answers the key itself. */
const onControl = (e: KeyboardEvent) => e.target instanceof HTMLElement && e.target.closest("a, button, [role=button]") !== null;

/** Give the returned handlers to the element that holds the columns. */
export function useBoardKeys(groups: TaskGroup[]) {
  const open = useTaskNav();
  const peek = usePeek();
  const hoveredId = useRef<string | null>(null);

  const hovered = (): Task | undefined => {
    const id = hoveredId.current;
    if (!id || isDraft(id)) return undefined;
    for (const group of groups) {
      const task = group.tasks.find((tk) => tk.id === id);
      if (task) return task;
    }
    return undefined;
  };

  useHotkeys({
    " ": (e) => {
      const task = hovered();
      if (!task || onControl(e)) return;
      e.preventDefault();
      open.peek(task.key);
    },
    Enter: (e) => {
      const task = hovered();
      if (!task || onControl(e)) return;
      e.preventDefault();
      open.page(task.key);
    },
  });

  /** Moves the panel within its column (`down`), or to the same height in a column beside it (`across`). */
  const step = (down: number, across: number) => (e: KeyboardEvent) => {
    e.preventDefault();
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
  useHotkeys(
    {
      j: step(1, 0),
      k: step(-1, 0),
      ArrowDown: step(1, 0),
      ArrowUp: step(-1, 0),
      ArrowRight: step(0, 1),
      ArrowLeft: step(0, -1),
      " ": (e) => {
        if (onControl(e)) return;
        e.preventDefault();
        peek.close();
      },
    },
    { layer: "panel", enabled: peek.key !== undefined },
  );

  return {
    onMouseOver: (e: MouseEvent) => {
      hoveredId.current = (e.target as HTMLElement).closest<HTMLElement>("[data-task]")?.dataset.task ?? null;
    },
    onMouseLeave: () => {
      hoveredId.current = null;
    },
  };
}
