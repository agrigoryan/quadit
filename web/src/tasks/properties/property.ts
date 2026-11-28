// What a task property is: one kind of thing a task is filed under or
// carries (its status, its assignee, its labels, its due date…), described
// once, in a file of its own in this folder, and listed in index.ts. The
// pickers, the property panel, the bulk bar, the create dialog, the palette,
// the filters, the groupings and the timeline read these descriptions
// instead of naming the kinds. A part a kind has no use for is left out:
// a due date is not grouped by, so it has no grouping.

import type { ComponentType, ReactNode } from "react";
import type { Key } from "@/lib/i18n";
import { getRowEvenIfGone } from "@/data/selectors";
import type { Collections } from "@/data/store";
import type { Category, FeedEvent, FieldChange, Project, Task, TaskQuery } from "@/types/core";
import type { NewTaskDraft } from "@/tasks/draft";
import type { PickerItem } from "@/ui/picker";

/** "Nothing set", where an id would be: in a picker, a filter, a group. */
export const NONE = "none";
/**
 * The server's word for "an outside event" where a member's id would be: in
 * the "waiting on" filter, in a picker, and in the change that sets it.
 */
export const OUTSIDE = "outside";
/**
 * Whoever looks, where a member's id would be: in a filter, the page's
 * address and a saved view. A shared view that says it shows each person
 * their own tasks; only matching a task asks who that is.
 */
export const ME = "me";

export interface TaskProperty<Name extends string = string> {
  name: Name;
  /** What it is called: the label of its row in the panel, of its button in the bulk bar. */
  title: () => string;
  /**
   * Whether a task has it at all: a cycle where its project works in
   * cycles, a milestone once the task is in an epic. Where it is false the
   * panel has no row for it, and the bulk bar, the keys and the palette do
   * not offer it. Left out, every task has it.
   */
  appliesTo?: (task: Task, project: Project | undefined) => boolean;
  /**
   * The key that changes it on a list's row or selection and on the open
   * task, by its name in hooks/hotkeys.ts ("s", "shift+c"), and what the
   * shortcuts sheet calls it. It opens the picker; for a value typed in
   * the panel's own box (an estimate in any number), it puts the caret there.
   */
  key?: { key: string; shortcut: Key };
  /** Changing it by picking from a list, or from a picker of its own (a day). */
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
  /** Filtering a task list by it, and its word in a task query. */
  filter?: FilterPart;
  /** Grouping a task list by it: the list's sections, a board's columns. */
  group?: GroupPart;
}

/**
 * The tables grouping reads; a page passes only these, so it regroups only
 * when one of them changes. Statuses and labels are the live ones
 * (useLookup); members and epics are every row (useLookupEvenIfGone), so a
 * task still assigned to someone removed, or in a deleted epic, keeps a group
 * under that name.
 */
export type GroupSource = Pick<Collections, "statuses" | "members" | "epics" | "labels">;

/** A group a list is split into, before its tasks are put in. */
export interface GroupHead {
  /** Unique within the list. For status groups this is the status id (or the category, across projects). */
  id: string;
  title: string;
  /** The value the group stands for: a status id or category, a user id, an epic id, a label id, a priority. */
  value: string;
  category?: Category;
}

export interface GroupPart {
  /** Its name in the list's "Group" menu. */
  title: () => string;
  /**
   * The groups, in order, for the project in view (or for several). A quiet
   * one (someone removed, a deleted epic) is shown only while it holds a task.
   */
  groups: (c: GroupSource, projectId: string | undefined) => (GroupHead & { quiet?: boolean })[];
  /** The ids of the groups a task goes in, given which there are: several for labels; none leaves it out. */
  place: (task: Task, c: GroupSource, has: (id: string) => boolean) => string[];
  /** The mark beside a group's name. */
  Icon?: ComponentType<{ group: GroupHead }>;
  /** What a new task added to a list's group starts with. */
  draft?: (group: GroupHead) => NewTaskDraft;
  /** What the rows under its headings leave out, because the heading says it. Kept here so a row's props stay the same object. */
  hides?: { epic?: boolean; assignee?: boolean };
}

/**
 * The tables a stored query's names are looked up in: the live rows
 * (useLookup), so a name of something gone matches nothing; projects every
 * row (useLookupEvenIfGone), so a view of an archived project stays about it.
 */
export type QuerySource = Pick<Collections, "projects" | "members" | "statuses" | "labels" | "epics" | "cycles">;

/** What reading a stored query's words needs. */
export interface QueryContext {
  c: QuerySource;
  /** Whether a row of this project is one the query is about: any, when it names no project. */
  inScope: (projectId: string | undefined) => boolean;
}

/** The words of a task query that filter by a property: all but the project, the open question, the text and the order. */
export type FilterWord = Exclude<keyof TaskQuery, "project" | "has_open_decision" | "q" | "sort">;

export interface FilterPart {
  /** Its word in a task query: a saved view's query, the page's address (?label=bug). */
  word: FilterWord;
  /** Its name in the filter menu and on its chip. */
  title: () => string;
  /** How a query holds its values: a list of ids or names (left out), one word (waiting on), or numbers (priority). */
  holds?: "one" | "numbers";
  /** Offered only where it means something: a project's statuses, a project's cycles. */
  offered?: (project: Project | undefined) => boolean;
  /**
   * The values it can be set to, for the project in view or the whole
   * workspace. A hook. It is handed the values picked, for a kind whose
   * picked value may be one it no longer offers (an estimate off the scale).
   */
  useOptions: (project: Project | undefined, picked: string[]) => PickerItem[];
  /** Whether a task passes, for the values picked (never none); ME is already the id of whoever looks. */
  matches: (task: Task, picked: string[], c: Pick<Collections, "statuses">) => boolean;
  /**
   * The values a stored query stands for. A view may have been written by
   * hand or by an agent, with names where ids belong ("@coder", "art"); a
   * word that names nothing, or something gone, is left out.
   */
  read: (q: TaskQuery, ctx: QueryContext) => string[];
  /** A value as the page's address writes it, where that is not the value itself: a name, a handle. */
  address?: (id: string, c: QuerySource, projectId: string | undefined) => string;
  /** Its values name rows that can be deleted or people who can leave, so a saved view can name one that is gone. */
  canBeGone?: boolean;
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
    ctx: { changes: Changes; actorId: string; data: FeedEvent["data"]; taskId: string },
  ) => string | string[] | null;
}

/** A field's value as text, or "" when it is not one. */
export const asText = (v: unknown): string => (typeof v === "string" ? v : "");
/** A field's value as a list of ids, or [] when it is not one. */
export const asIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export interface PalettePart {
  /** The command's words, and the box's placeholder on the page of its values: "Change status…". */
  title: () => string;
  icon: ReactNode;
  /**
   * The values the open task can take, the one it has checked. A hook. It is
   * handed what is typed in the box, for a value made of it (a number).
   */
  useChoices: (task: Task, query: string) => Choice[];
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
  /**
   * Left out until the person picks one: the template's, or none. null is
   * none, whatever the template says; 0 is an estimate where the project
   * allows it.
   */
  estimate?: number | null;
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
  /** Takes the value's control (the button of a picked value, the box of a typed one), so its key opens the picker next to it or puts the caret in it. */
  takeControl: (el: HTMLElement | null) => void;
}

/** Changing it by picking: rows to pick from, or a list of its own. */
export type PickerPart = {
  /** The picker's title and the words in its search box: "Change status…". */
  title: () => string;
} & (RowsPicker | OwnListPicker);

/** Picked from rows the shared list draws (tasks/property-picker.tsx). */
export interface RowsPicker {
  /**
   * The rows offered for these tasks, and what they all have now: one value,
   * or, for a kind that holds several (labels), a list, where a pick adds or
   * takes away one and the list stays open. A hook: it reads only what this
   * kind needs.
   */
  useItems: (tasks: Task[]) => { items: PickerItem[]; value: string | string[] | undefined };
  /** Sets the picked value on every one of the tasks. */
  pick: (tasks: Task[], id: string) => void;
  List?: undefined;
}

/**
 * A list of its own, where picking a row may do more than set the value (an
 * outside wait asks what it waits for), or where there may be no rows at all
 * (an estimate in any number is typed; a due date is picked in the date picker).
 */
export interface OwnListPicker {
  List: ComponentType<PickerListProps>;
  useItems?: undefined;
  pick?: undefined;
}

export interface PickerListProps {
  tasks: Task[];
  close: () => void;
}

/**
 * Whether the task has the property (its appliesTo). A render passes the
 * task's project as it has it; a key's handler leaves it out, and it is
 * read from the store.
 */
export const applies = (
  property: Pick<TaskProperty, "appliesTo">,
  task: Task,
  project = getRowEvenIfGone("projects", task.project_id),
) => property.appliesTo?.(task, project) ?? true;

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
