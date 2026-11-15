// What a task property is: one kind of thing a task is filed under or
// carries (its status, its assignee, its labels, its due date…), described
// once, in a file of its own in this folder, and listed in index.ts. The
// pickers, the property panel, the bulk bar, the create dialog, the palette,
// the filters, the groupings and the timeline read these descriptions
// instead of naming the kinds. A part a kind has no use for is left out:
// a due date is typed, not picked from a list, so it has no picker.

import type { ComponentType } from "react";
import type { Task } from "@/lib/types";
import type { PickerItem } from "@/ui/picker";

/** "Nothing set", where an id would be: in a picker, a filter, a group. */
export const NONE = "none";
/**
 * The server's word for "an outside event" where a member's id would be: in
 * the "waiting on" filter, in a picker, and in the change that sets it.
 */
export const OUTSIDE = "outside";

export interface TaskProperty<Name extends string = string> {
  name: Name;
  /** What it is called: the label of its row in the panel, of its button in the bulk bar. */
  title: () => string;
  /** Changing it by picking from a list. */
  picker?: PickerPart;
  /** A value made from typed words, where it does not exist yet: a label. Answers the new value's id at once. */
  make?: { run: (projectId: string | undefined, name: string) => string; label: (name: string) => string };
  /** The settings page where its values are kept, linked from the foot of its lists. */
  manage?: "labels" | "statuses";
  /** Its row in the task's property panel; it draws nothing where the task or its project has no such thing. */
  Panel?: ComponentType<PanelProps>;
}

/** What the property panel hands each row. */
export interface PanelProps {
  task: Task;
  /** At the side of the task's page, where the column is narrow. */
  side?: boolean;
  /** The viewer may not change the task: the row's controls are off. */
  readOnly: boolean;
  /** The row's picker, which the panel's keys open too. */
  picker: { open: boolean; onOpenChange: (open: boolean) => void };
  /** Takes the value's button, so a key's picker opens next to it. */
  takeButton: (el: HTMLButtonElement | null) => void;
}

export interface PickerPart {
  /** The picker's title and the words in its search box: "Change status…". */
  title: () => string;
  /** The key that opens the picker on a list's current row and on the open task. */
  hotkey?: string;
  /** The rows offered for these tasks, and what they all have now. A hook: it reads only what this kind needs. */
  useItems: (tasks: Task[]) => { items: PickerItem[]; value: string | string[] | undefined };
  /** Sets the picked value on every one of the tasks. */
  pick: (tasks: Task[], id: string) => void;
  /** It holds several values: a pick adds or takes away one, and the list stays open. */
  multiple?: boolean;
  /** Its own list, where picking a row may do more than set the value (an outside wait asks what it waits for). */
  List?: ComponentType<PickerListProps>;
}

export interface PickerListProps {
  tasks: Task[];
  close: () => void;
}

/** The value every one of the tasks has, or undefined when they differ. */
export function shared<T>(tasks: Task[], get: (task: Task) => T): T | undefined {
  const first = tasks[0];
  if (!first) return undefined;
  const value = get(first);
  return tasks.every((task) => get(task) === value) ? value : undefined;
}

/** A kind changed by picking from a list. */
export type PickerProperty = TaskProperty & { picker: PickerPart };
