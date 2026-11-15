// Every task property, in the order the task's property panel shows them.
// Each is described in a file of its own beside this one (property.ts says
// what a description holds); this table is the one list of them. Adding a
// property is a new file here and a line in this table.

import { assignee } from "@/tasks/properties/assignee";
import { budget } from "@/tasks/properties/budget";
import { cycle } from "@/tasks/properties/cycle";
import { due } from "@/tasks/properties/due";
import { epic } from "@/tasks/properties/epic";
import { estimate } from "@/tasks/properties/estimate";
import { label } from "@/tasks/properties/label";
import { milestone } from "@/tasks/properties/milestone";
import { parent } from "@/tasks/properties/parent";
import { priority } from "@/tasks/properties/priority";
import { project } from "@/tasks/properties/project";
import type { PickerProperty, TaskProperty } from "@/tasks/properties/property";
import { status } from "@/tasks/properties/status";
import { waiting } from "@/tasks/properties/waiting";

const TABLE = [
  status,
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

/** The properties a key opens the picker of (S, A, P, L), in the table's order. */
export const KEYED = PROPERTIES.filter((p): p is TaskProperty<PropertyName> & PickerProperty => !!p.picker?.hotkey);
