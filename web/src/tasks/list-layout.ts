// Where everything sits in the task list (tasks/task-list.tsx): its groups
// laid out one under the other, each a heading over its rows, as positions
// in pixels down the full height of the list. Only the rows on screen are
// drawn; this says which those are, and where the row at a position is.

import { useMemo } from "react";
import type { Task } from "@/lib/types";
import type { TaskGroup } from "@/tasks/filters";

// Heights in pixels of a row (h-9) and a group heading (h-8), and how far past the edges rows are kept drawn.
export const ROW = 36;
const HEAD = 32;
export const OVERSCAN = 8 * ROW;
/** Room under the last row, so the bulk bar never covers it. */
export const TAIL = 96;

/** Where one group sits in the full height of the list. */
export interface Section {
  group: TaskGroup;
  top: number;
  head: number;
  /** Rows it shows: none while folded. */
  rows: number;
  height: number;
  /** The position of its first row among all the rows showing. */
  first: number;
}

/** One row on screen: grouped by label, a task can be in the list more than once, so a row is a task in a group. */
export interface Row {
  key: string;
  task: Task;
}

export interface ListLayout {
  sections: Section[];
  /** The rows showing, in order: those of folded groups are left out. */
  rows: Row[];
  /** The position of each row among `rows`, by its key. */
  indexOf: Map<string, number>;
  /** The height of all the groups together. */
  total: number;
}

export const rowKey = (group: TaskGroup, task: Task) => `${group.id}:${task.id}`;

/** Lays the groups out one under the other; a folded group is its heading alone. */
export function layOut(groups: TaskGroup[], folded: ReadonlySet<string>): ListLayout {
  const sections: Section[] = [];
  const rows: Row[] = [];
  const indexOf = new Map<string, number>();
  let top = 0;
  for (const group of groups) {
    const head = group.kind === "none" ? 0 : HEAD;
    const shown = folded.has(group.id) ? 0 : group.tasks.length;
    const first = rows.length;
    for (const task of group.tasks.slice(0, shown)) {
      const key = rowKey(group, task);
      indexOf.set(key, rows.length);
      rows.push({ key, task });
    }
    const height = head + shown * ROW;
    sections.push({ group, top, head, rows: shown, height, first });
    top += height;
  }
  return { sections, rows, indexOf, total: top };
}

/** The layout, worked out again only when the groups or the folding change. */
export function useListLayout(groups: TaskGroup[], folded: ReadonlySet<string>): ListLayout {
  return useMemo(() => layOut(groups, folded), [groups, folded]);
}

/**
 * The position `step` rows on from `from`, kept within the list. From no
 * row (-1), a step down starts at the first row and a step up at the last.
 */
export function stepFrom(from: number, step: number, count: number): number {
  if (from < 0) return step > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, from + step));
}

/** Where the row at this position is drawn, and the height of the heading that sticks over its group. */
export function rowPlace(sections: Section[], index: number): { top: number; head: number } | undefined {
  const section = sections.findLast((s) => s.first <= index && s.rows > 0);
  if (!section) return undefined;
  return { top: section.top + section.head + (index - section.first) * ROW, head: section.head };
}

/** Which of a section's rows lie between the heights `from` and `to`: the ones to draw. */
export function rowsBetween(section: Section, from: number, to: number): { start: number; end: number } {
  const body = section.top + section.head;
  const start = Math.max(0, Math.min(section.rows, Math.floor((from - body) / ROW)));
  const end = Math.max(start, Math.min(section.rows, Math.ceil((to - body) / ROW)));
  return { start, end };
}
