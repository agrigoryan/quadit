// Every task property, in the order the task's property panel shows them.
// Each is described in a file of its own beside this one (property.ts says
// what a description holds); this table is the one list of them. Adding a
// property is a new file here and a line in this table.

import { assignee } from "@/tasks/properties/assignee";
import { cycle } from "@/tasks/properties/cycle";
import { epic } from "@/tasks/properties/epic";
import { label } from "@/tasks/properties/label";
import { milestone } from "@/tasks/properties/milestone";
import { priority } from "@/tasks/properties/priority";
import { project } from "@/tasks/properties/project";
import type { PickerProperty, TaskProperty } from "@/tasks/properties/property";
import { status } from "@/tasks/properties/status";
import { waiting } from "@/tasks/properties/waiting";

export const PROPERTIES = [status, assignee, waiting, priority, label, epic, milestone, cycle, project] as const;

/** The name of every property: a consumer that switches on it is checked for every one. */
export type PropertyName = (typeof PROPERTIES)[number]["name"];

/** The properties a key opens the picker of (S, A, P, L), in the table's order. */
export const KEYED: PickerProperty[] = (PROPERTIES as readonly TaskProperty[]).filter(
  (p): p is PickerProperty => !!p.picker?.hotkey,
);
