// Cmd+Shift+Up opens the open task's parent, Cmd+Shift+Down its first
// sub-task: the same way their links in the panel open them, in the panel
// over a list or as a page from a page.

import { useRowEvenIfGone } from "@/data/selectors";
import { useHotkeys } from "@/hooks/hotkeys";
import type { Task } from "@/types/core";
import { useSubtasks } from "@/detail/data";
import { useTaskNav } from "@/nav/task-link";

/** Binds the two keys for the task that is open. In a field they are the field's: they choose text there. */
export function useFamilyKeys(task: Task) {
  const nav = useTaskNav();
  // Named even in the trash or the archive, as the link to it is.
  const parent = useRowEvenIfGone("tasks", task.parent_id);
  const first = useSubtasks(task.id)[0];
  const go = (to: Task | undefined) => (e: KeyboardEvent) => {
    if (!to) return;
    e.preventDefault();
    nav.peek(to.key);
  };
  useHotkeys(
    { "mod+shift+ArrowUp": go(parent), "mod+shift+ArrowDown": go(first) },
    { layer: "panel", guardChords: true },
  );
}
