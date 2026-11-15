// The task list's keys (tasks/task-list.tsx). J/K and the arrows move the
// current row, Space shows its task in the panel, Enter opens the task's
// page, X selects it, Escape clears the selection, and S/A/P/L open the
// status, assignee, priority and labels picker for the selection or the
// current row. While the panel is open J/K move it to the next task, and
// Space puts it away with the current row still on the task.

import { useHotkeys } from "@/lib/hotkeys";
import { isDraft } from "@/lib/store";
import { useTaskNav } from "@/lib/task-link";
import type { Task } from "@/lib/types";
import type { ListFocus } from "@/tasks/list-focus";
import { isOnControl, usePanelStepKeys } from "@/tasks/panel-keys";
import type { TaskProperty } from "@/tasks/property-picker";

const KEY_TO_PROPERTY: Record<string, TaskProperty> = { s: "status", a: "assignee", p: "priority", l: "labels" };

interface Options {
  focus: ListFocus;
  /** The key of the current row, for X. */
  focusKey: string | null;
  select: (task: Task, range: boolean, at?: string) => void;
  /** Escape: empties the selection, when there is one. */
  clearSelection: () => void;
  openPicker: (kind: TaskProperty) => void;
}

export function useTaskListKeys({ focus, focusKey, select, clearSelection, openPicker }: Options) {
  const open = useTaskNav();
  const { focused, move, showInPanel, stepPanel } = focus;

  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
    ArrowDown: (e) => {
      e.preventDefault();
      move(1);
    },
    ArrowUp: (e) => {
      e.preventDefault();
      move(-1);
    },
    Enter: () => {
      // A draft has no address yet.
      if (focused && !isDraft(focused.id)) open.page(focused.key);
    },
    " ": (e) => {
      if (!focused || isOnControl(e)) return;
      e.preventDefault(); // or the list scrolls a screen down
      showInPanel(focused);
    },
    x: () => {
      if (focused) select(focused, false, focusKey ?? undefined);
    },
    Escape: clearSelection,
    ...Object.fromEntries(
      Object.entries(KEY_TO_PROPERTY).map(([key, kind]) => [
        key,
        (e: KeyboardEvent) => {
          e.preventDefault(); // or the letter lands in the picker's search box
          openPicker(kind);
        },
      ]),
    ),
  });

  usePanelStepKeys({ onStep: stepPanel });
}
