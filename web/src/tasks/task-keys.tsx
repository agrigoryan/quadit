// The keys that act on the tasks the keyboard is on, wherever tasks are
// shown: a list's focused row or its selection, the board's card, the
// inbox's item, the open task. I gives them to me, and takes them off me
// when they are all mine already; Cmd+. copies their keys; Cmd+Shift+. a
// git branch name for the first; Cmd+Backspace moves them to the trash.
// Where tasks are listed, S, A, P and L also open a property's picker
// beside the row; the open task has its own (detail/properties.tsx).

import { type ReactElement, useRef, useState } from "react";
import { can, mayBeGivenWork } from "@/data/access";
import { copyAndSay } from "@/data/files";
import { getRowEvenIfGone, useLookup } from "@/data/selectors";
import { getState, isDraft } from "@/data/store";
import { useHotkeys } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { Task } from "@/types/core";
import { setAssignee, trashTasks } from "@/tasks/actions";
import { branchName } from "@/tasks/branch-name";
import { KEYED } from "@/tasks/properties";
import type { PickerProperty } from "@/tasks/properties/property";
import { TaskPropertyPicker } from "@/tasks/property-picker";

/**
 * I: gives the tasks to me, or takes them off me when every one is mine
 * already. A task of a project I may not be given work in is left as it
 * is, and a toast says so; nothing at all for a task I may not change.
 */
export function toggleMine(tasks: Task[]) {
  const me = getState().me;
  if (!me) return;
  const refused = tasks.find((task) => !mayBeGivenWork(me, task.project_id));
  if (refused) {
    const project = getRowEvenIfGone("projects", refused.project_id);
    toast.info(t("keys.notGivenWork", { project: project?.name ?? refused.key }));
  }
  const mine = tasks.filter((task) => task !== refused && mayBeGivenWork(me, task.project_id));
  if (mine.length === 0 || !mine.every((task) => can(me).editTask(task))) return;
  setAssignee(mine, mine.every((task) => task.assignee_id === me.user_id) ? null : me.user_id);
}

/** Cmd+Shift+.: a git branch name for the task, copied. */
export const copyBranchName = (task: Task) => copyAndSay(branchName(task));

interface Options {
  /** The tasks a key acts on, as it is pressed. A row not yet numbered by the server is left out. */
  tasksFor: (e: KeyboardEvent) => Task[];
  /**
   * Where a property's picker opens for these tasks (the row or card of the
   * first). Given, S, A, P and L open one; left out, as for the open task,
   * those keys are someone else's.
   */
  anchorFor?: (tasks: Task[]) => Element | null;
  /** "panel" for the open task, whose keys go on working over the page under it. */
  layer?: "page" | "panel";
  /** Runs once Cmd+Backspace has moved the tasks to the trash: the open task closes. */
  onTrashed?: () => void;
}

/** Binds the keys; returns the property picker to draw, open while a key has opened it. */
export function useTaskKeys({ tasksFor, anchorFor, layer = "page", onTrashed }: Options): ReactElement | null {
  const [picker, setPicker] = useState<KeyedPickerProps | null>(null);

  /** The tasks to act on, none of them a draft; `run` is not called when there are none. */
  const on = (run: (tasks: Task[], e: KeyboardEvent) => void) => (e: KeyboardEvent) => {
    const tasks = tasksFor(e).filter((task) => !isDraft(task.id));
    if (tasks.length > 0) run(tasks, e);
  };

  useHotkeys(
    {
      i: on(toggleMine),
      "mod+.": on((tasks, e) => {
        e.preventDefault();
        void copyAndSay(tasks.map((task) => task.key).join(", "));
      }),
      "mod+shift+.": on(([first], e) => {
        e.preventDefault();
        if (first) void copyBranchName(first);
      }),
      "mod+Backspace": on((tasks, e) => {
        // Like the menu's Move to trash: not for a task I may not change.
        const me = getState().me;
        if (!tasks.every((task) => can(me).editTask(task))) return;
        e.preventDefault();
        trashTasks(tasks);
        onTrashed?.();
      }),
      ...(anchorFor &&
        Object.fromEntries(
          KEYED.map((property) => [
            property.picker.hotkey?.key,
            on((tasks, e) => {
              // Like the row's own buttons: nothing to pick for a task I may not change.
              const me = getState().me;
              if (!tasks.every((task) => can(me).editTask(task))) return;
              e.preventDefault(); // or the letter lands in the picker's search box
              setPicker({ property, ids: tasks.map((task) => task.id), anchor: anchorFor(tasks) });
            }),
          ]),
        )),
    },
    { layer, guardChords: true },
  );

  return picker && <KeyedPicker {...picker} onClose={() => setPicker(null)} />;
}

interface KeyedPickerProps {
  property: PickerProperty;
  ids: string[];
  /** What it opens beside. */
  anchor: Element | null;
}

/** The picker a key opened, on the tasks as they are now: a second label picked sees the first. */
function KeyedPicker({ property, ids, anchor: at, onClose }: KeyedPickerProps & { onClose: () => void }) {
  // Each opening is a new picker: the element it opens beside stays the one it was given.
  const anchor = useRef(at);
  const live = useLookup("tasks");
  const tasks = ids.flatMap((id) => live[id] ?? []);
  if (tasks.length === 0) return null;
  return (
    <TaskPropertyPicker
      property={property}
      tasks={tasks}
      open
      onOpenChange={(open) => !open && onClose()}
      anchor={anchor}
    />
  );
}
