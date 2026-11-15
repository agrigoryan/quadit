// What a task property is: one kind of thing a task is filed under or
// carries (its status, its assignee, its labels, its due date…), described
// once, in a file of its own in this folder, and listed in index.ts. The
// pickers, the property panel, the bulk bar, the create dialog, the palette,
// the filters, the groupings and the timeline read these descriptions
// instead of naming the kinds. A part a kind has no use for is left out:
// a due date is typed, not picked from a list, so it has no picker.

import type { ComponentType, ReactNode } from "react";
import type { Key } from "@/lib/i18n";
import type { FeedEvent, FieldChange, Project, Task } from "@/lib/types";
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
  /** Its pill in the create dialog. */
  Create?: ComponentType<CreateProps>;
  /** Changing it on the open task from the command palette: a command that opens a page of its values. */
  palette?: PalettePart;
  /** Changing it on every task of a selection, from the bulk bar. */
  bulk?: BulkPart;
  /** How the timeline says it changed: the task's fields it is stored in, each with its phrase. */
  timeline?: Phrase[];
}

/** The fields one change to a task changed, by name. */
export type Changes = Record<string, FieldChange>;

/**
 * What the timeline says, after the actor's name, for one field that
 * changed: "moved this from Todo to Doing". Nothing (null or []) when there
 * is nothing worth saying, or when another field of the same change says it.
 */
export interface Phrase {
  field: string;
  say: (
    change: FieldChange,
    ctx: { changes: Changes; actorId: string; data: FeedEvent["data"] },
  ) => string | string[] | null;
}

/** A field's value as text, or "" when it is not one. */
export const asText = (v: unknown): string => (typeof v === "string" ? v : "");
/** A field's value as a list of ids, or [] when it is not one. */
export const asIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export interface PalettePart {
  icon: ReactNode;
  /** The values the open task can take, the one it has checked. A hook. */
  useChoices: (task: Task) => Choice[];
  /** What the page says when there is no value at all to offer. */
  empty?: () => string;
}

/** One value on the palette's page of a property. */
export interface Choice {
  id: string;
  label: string;
  /** More words the search should match. */
  words?: string;
  detail?: string;
  /** Drawn after the detail: whether anything is listening for an agent. */
  mark?: ReactNode;
  icon: ReactNode;
  checked: boolean;
  apply: () => void;
}

export interface BulkPart {
  icon: ReactNode;
  /** A button on the bar itself, named by the title; or an entry of its More menu, after a line when it moves the tasks rather than changing them. */
  place: "bar" | "menu" | "move";
  /** The menu entry's words. */
  label?: () => string;
  /** Offered only where the project has such a thing (cycles, estimates). */
  offered?: (project: Project | undefined) => boolean;
  /** For a value typed rather than picked: the form that sets it on them all. */
  Form?: ComponentType<{ tasks: Task[]; onDone: () => void }>;
}

/** What the create dialog collects besides the title and description. */
export interface TaskFields {
  statusId: string;
  assigneeId: string;
  priority: number;
  labelIds: string[];
  epicId: string;
  parentId: string;
  dueOn: string;
  templateId: string;
}

/** What the create dialog hands each property's pill. */
export interface CreateProps {
  project: Project;
  value: TaskFields;
  onChange: (patch: Partial<TaskFields>) => void;
  /** For several tasks at once, which leave out what only one task can have (a parent). */
  shared?: boolean;
  /** Called before leaving for a settings page, so the dialog can close. */
  onLeave?: () => void;
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
  /** The key that opens the picker on a list's current row and on the open task, and what the shortcuts sheet calls it. */
  hotkey?: { key: string; shortcut: Key };
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

export const hasPicker = <P extends TaskProperty>(p: P): p is P & PickerProperty => p.picker !== undefined;
