// The keys that act on the tasks the keyboard is on, wherever tasks are
// shown: a list's focused row or its selection, the board's card, the
// inbox's item, the open task. I gives them to me, and takes them off me
// when they are all mine already; Shift+S has me watch them, or stop;
// Cmd+. copies their keys; Cmd+Shift+. a git branch name for the first,
// Cmd+Option+P its context pack; Cmd+Backspace moves them to the trash.
// Where tasks are listed, the keys of the task properties (S, A, P, L,
// Shift with P, M, C, E or D) also open the property's picker, or its
// form, beside the row; the open task has its own (detail/properties.tsx).

import { type ReactElement, useRef, useState } from "react";
import { can, mayBeGivenWork } from "@/data/access";
import { api, workspacePath } from "@/data/api";
import { copyAndSay } from "@/data/files";
import { getRow, getRowEvenIfGone, useLookup } from "@/data/selectors";
import { getState, isDraft } from "@/data/store";
import { useHotkeys } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { Task } from "@/types/core";
import { setAssignee, setWatching, trashTasks } from "@/tasks/actions";
import { branchName } from "@/tasks/branch-name";
import { KEYED, type KeyedProperty } from "@/tasks/properties";
import { applies, hasPicker } from "@/tasks/properties/property";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";

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

/**
 * Shift+S: has me watch the tasks, or stop watching them when I watch
 * every one already. Nothing for someone who may not make changes.
 */
export function toggleWatching(tasks: Task[]) {
  const me = getState().me;
  if (!me || !can(me).write) return;
  setWatching(tasks, !tasks.every((task) => !!getRow("watchers", `${me.user_id}:${task.id}`)));
}

/** Cmd+Shift+.: a git branch name for the task, copied. */
export const copyBranchName = (task: Task) => copyAndSay(branchName(task));

/**
 * Cmd+Option+P: the task's context pack (the task, its parents, epic,
 * standing preferences, recent decisions and pages), as an agent reads it,
 * copied to paste into one. Call it inside the key press or click: the copy
 * is asked for there, before the pack has come (data/files.ts copyText).
 */
export const copyContextPack = (task: Task) =>
  copyAndSay(api.getText(workspacePath(getState().slug, `/tasks/${task.key}/context?format=text`)));

interface Options {
  /** The tasks a key acts on, as it is pressed. A row not yet numbered by the server is left out. */
  tasksFor: (e: KeyboardEvent) => Task[];
  /**
   * Where a property's picker or form opens for these tasks (the row or
   * card of the first). Given, the properties' keys open one; left out, as
   * for the open task, those keys are someone else's.
   */
  anchorFor?: (tasks: Task[]) => Element | null;
  /** "panel" for the open task, whose keys go on working over the page under it. */
  layer?: "page" | "panel";
  /** Runs once Cmd+Backspace has moved the tasks to the trash: the open task closes. */
  onTrashed?: () => void;
}

/** Binds the keys; returns the property's picker or form to draw, open while a key has opened it. */
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
      "shift+s": on(toggleWatching),
      "mod+.": on((tasks, e) => {
        e.preventDefault();
        void copyAndSay(tasks.map((task) => task.key).join(", "));
      }),
      "mod+shift+.": on(([first], e) => {
        e.preventDefault();
        if (first) void copyBranchName(first);
      }),
      // By the key P wherever the layout puts it: Option with P types π on a Mac.
      "mod+alt+p": on(([first], e) => {
        e.preventDefault();
        if (first) void copyContextPack(first);
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
            property.key.key,
            on((tasks, e) => {
              // Like the row's own buttons: nothing to pick for a task I may not change, nor one without the property.
              const me = getState().me;
              if (!tasks.every((task) => can(me).editTask(task) && applies(property, task))) return;
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
  property: KeyedProperty;
  ids: string[];
  /** What it opens beside. */
  anchor: Element | null;
}

/**
 * The picker a key opened, or the form of a typed value, on the tasks as
 * they are now: a second label picked sees the first.
 */
function KeyedPicker({ property, ids, anchor: at, onClose }: KeyedPickerProps & { onClose: () => void }) {
  // Each opening is a new picker: the element it opens beside stays the one it was given.
  const anchor = useRef(at);
  const live = useLookup("tasks");
  const tasks = ids.flatMap((id) => live[id] ?? []);
  if (tasks.length === 0) return null;
  const { Form } = property;
  if (hasPicker(property))
    return (
      <TaskPropertyPicker
        property={property}
        tasks={tasks}
        open
        onOpenChange={(open) => !open && onClose()}
        anchor={anchor}
      />
    );
  if (!Form) return null;
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent align="start" aria-label={property.title()} className="w-60 p-3">
        <Form tasks={tasks} onDone={onClose} />
      </PopoverContent>
    </Popover>
  );
}
