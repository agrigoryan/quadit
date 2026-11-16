// Every task property, in the order the task's property panel shows them.
// Each is described in a file of its own beside this one (property.ts says
// what a description holds); this table is the one list of them. Adding a
// property is a new file here and a line in this table, and in the lists
// below it belongs in: a few places show the properties in an order of their
// own, and these lists keep those orders as they are.

import type { ComponentType } from "react";
import { assignee } from "@/tasks/properties/assignee";
import { budget } from "@/tasks/properties/budget";
import { category } from "@/tasks/properties/category";
import { cycle } from "@/tasks/properties/cycle";
import { due } from "@/tasks/properties/due";
import { epic } from "@/tasks/properties/epic";
import { estimate } from "@/tasks/properties/estimate";
import { label } from "@/tasks/properties/label";
import { milestone } from "@/tasks/properties/milestone";
import { parent } from "@/tasks/properties/parent";
import { priority } from "@/tasks/properties/priority";
import { project } from "@/tasks/properties/project";
import type {
  BulkPart,
  CreateProps,
  FilterPart,
  GroupPart,
  PalettePart,
  PickerProperty,
  TaskProperty,
} from "@/tasks/properties/property";
import { status } from "@/tasks/properties/status";
import { waiting } from "@/tasks/properties/waiting";

const TABLE = [
  status,
  category,
  assignee,
  waiting,
  priority,
  label,
  epic,
  milestone,
  cycle,
  estimate,
  due,
  parent,
  budget,
  project,
] as const;

/** The name of every property: a consumer that switches on it is checked for every one. */
export type PropertyName = (typeof TABLE)[number]["name"];

export const PROPERTIES: readonly TaskProperty<PropertyName>[] = TABLE;

/**
 * The bulk bar's, in its order: the More menu has the due date before the
 * estimate, where the panel has them the other way round.
 */
export const BULK: (TaskProperty<PropertyName> & { bulk: BulkPart })[] = [
  status,
  assignee,
  priority,
  label,
  epic,
  cycle,
  due,
  estimate,
  project,
];

/** The create dialog's, in its order: the parent before the due date, where the panel has them the other way round. */
export const CREATE: (TaskProperty<PropertyName> & { Create: ComponentType<CreateProps> })[] = [
  status,
  assignee,
  priority,
  label,
  epic,
  parent,
  due,
];

/**
 * The order the timeline says what changed in, when one change carries
 * several: the budget straight after the wait, where the panel shows it last.
 */
export const TIMELINE: TaskProperty<PropertyName>[] = [
  status,
  assignee,
  waiting,
  budget,
  priority,
  label,
  epic,
  milestone,
  cycle,
  estimate,
  due,
  parent,
  project,
];

const FILTER_TABLE = [assignee, status, category, label, priority, epic, cycle, waiting] as const;

/** The name of each property a task list can be filtered by. */
export type FilterName = (typeof FILTER_TABLE)[number]["name"];

/**
 * The filters, in the filter menu's order, which is also the order of the
 * words in a page's address and a saved view's query: the assignee first,
 * the wait last, unlike the panel.
 */
export const FILTERS: readonly (TaskProperty<FilterName> & { filter: FilterPart })[] = FILTER_TABLE;

const GROUP_TABLE = [status, assignee, label, epic, priority] as const;

/** How a list can be grouped: by one of these properties, or not at all. */
export type Grouping = (typeof GROUP_TABLE)[number]["name"] | "none";

/** What a list can be grouped by, in the "Group" menu's order: the label before the epic and the priority, unlike the panel. */
export const GROUPINGS: readonly (TaskProperty<Exclude<Grouping, "none">> & { group: GroupPart })[] = GROUP_TABLE;

/** The ones the command palette changes on the open task, in the table's order. */
export const PALETTE = PROPERTIES.filter(
  (p): p is TaskProperty<PropertyName> & PickerProperty & { palette: PalettePart } => !!p.picker && !!p.palette,
);

/** A property with a key, and a picker or a form for the key to open. */
export type KeyedProperty = TaskProperty<PropertyName> & Required<Pick<TaskProperty, "key">>;

/** The properties a key changes (S, A, P, L, Shift+P…), in the table's order. */
export const KEYED = PROPERTIES.filter((p): p is KeyedProperty => !!p.key && (!!p.picker || !!p.Form));
