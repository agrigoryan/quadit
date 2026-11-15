// Where everything sits in the task list (tasks/task-list.tsx): its groups
// laid out one under the other, each a heading over its rows, as positions
// in pixels down the full height of the list. Only the rows on screen are
// drawn; this says which those are, and where the row at a position is.
//
// Nested, a group's rows are a tree: each sub-task under its parent. A task
// stays in the group its own value puts it in; a parent that is not in that
// group is shown above its sub-tasks there as a context row, which the
// group does not count and which cannot be selected.

import type { Dict } from "@/lib/store";
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
  /** Where the row sits in its group's tree. Left out when nothing in the list is nested. */
  branch?: Branch;
}

/** A row's place in its group's tree. */
export interface Branch {
  /** How many parents it is nested under: 0 at the top. */
  depth: number;
  /** Not one of the group's own tasks: shown only as the parent of some that are. */
  context: boolean;
  /** How many rows are nested right under it, folded away or not. */
  children: number;
  folded: boolean;
  /**
   * For each level it is nested by, from the top: whether the tree's line on
   * that level runs on below this row (a later row on that level follows).
   * The last says whether this row has a later sibling.
   */
  rails: boolean[];
  /** Its place among its siblings, from 1, and how many there are. */
  position: number;
  siblings: number;
}

/** How to nest: the tasks a parent is looked up in, and the list's order, which siblings follow too. */
export interface Nesting {
  tasks: Dict<Task>;
  compare: (a: Task, b: Task) => number;
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

/**
 * The row that now shows the task a row key was for, when that row itself is
 * gone: the task moved to another group (its status was changed), so its key
 * changed with it. Its own row there, not one that shows it for context.
 */
export function rowOfSameTask(rows: Row[], key: string): Row | undefined {
  return rows.find((row) => !row.branch?.context && key.endsWith(`:${row.task.id}`));
}

/**
 * Lays the groups out one under the other; a folded group is its heading
 * alone. `folded` holds the groups folded, by id, and the parents folded, by
 * row key. Given `nesting`, each group's rows are its tree (see the top of
 * this file); without it they are the group's tasks in the group's order.
 */
export function layOut(groups: TaskGroup[], folded: ReadonlySet<string>, nesting?: Nesting): ListLayout {
  const sections: Section[] = [];
  const rows: Row[] = [];
  let top = 0;
  for (const group of groups) {
    const head = group.kind === "none" ? 0 : HEAD;
    const first = rows.length;
    if (!folded.has(group.id)) {
      if (nesting) rows.push(...treeRows(group, folded, nesting));
      else for (const task of group.tasks) rows.push({ key: rowKey(group, task), task });
    }
    const shown = rows.length - first;
    const height = head + shown * ROW;
    sections.push({ group, top, head, rows: shown, height, first });
    top += height;
  }
  // With no parent anywhere, the list looks as it does flat: no room kept for a fold control.
  if (!rows.some((row) => row.branch && row.branch.children > 0)) for (const row of rows) row.branch = undefined;
  const indexOf = new Map(rows.map((row, i) => [row.key, i]));
  return { sections, rows, indexOf, total: top };
}

/**
 * One group's rows as a tree. Its tasks are joined by the direct parent of
 * each, when the parent is live: as a context row if the group does not hold
 * it. Only the direct parent: a whole chain of context rows above one task
 * would bury it. A context row is itself nested when its own parent is
 * there. A cycle in the parents (bad data) is cut at its first task in order.
 */
function treeRows(group: TaskGroup, folded: ReadonlySet<string>, { tasks, compare }: Nesting): Row[] {
  const context = new Map<string, Task>();
  const members = new Set(group.tasks.map((task) => task.id));
  for (const task of group.tasks) {
    const parent = task.parent_id ? tasks[task.parent_id] : undefined;
    if (parent && !parent.deleted_at && !parent.archived_at && !members.has(parent.id)) context.set(parent.id, parent);
  }
  const nodes = [...group.tasks, ...context.values()].sort(compare);
  const inGroup = new Set(nodes.map((task) => task.id));

  const parentOf = new Map<string, string>();
  for (const task of nodes) if (task.parent_id && inGroup.has(task.parent_id)) parentOf.set(task.id, task.parent_id);
  for (const task of nodes) {
    const seen = new Set<string>();
    for (let up = parentOf.get(task.id); up !== undefined && !seen.has(up); up = parentOf.get(up)) {
      if (up === task.id) {
        parentOf.delete(task.id);
        break;
      }
      seen.add(up);
    }
  }

  const childrenOf = new Map<string | undefined, Task[]>();
  for (const task of nodes) {
    const under = parentOf.get(task.id);
    const list = childrenOf.get(under);
    if (list) list.push(task);
    else childrenOf.set(under, [task]);
  }

  const rows: Row[] = [];
  const walk = (under: string | undefined, rails: boolean[]) => {
    const siblings = childrenOf.get(under) ?? [];
    siblings.forEach((task, i) => {
      const key = rowKey(group, task);
      const children = childrenOf.get(task.id)?.length ?? 0;
      const shut = children > 0 && folded.has(key);
      const own = under === undefined ? rails : [...rails, i < siblings.length - 1];
      rows.push({
        key,
        task,
        branch: {
          depth: own.length,
          context: !members.has(task.id),
          children,
          folded: shut,
          rails: own,
          position: i + 1,
          siblings: siblings.length,
        },
      });
      if (!shut) walk(task.id, own);
    });
  };
  walk(undefined, []);
  return rows;
}

/**
 * What Left (`by` -1) or Right (+1) does on the row at `index`, as in a tree:
 * Left folds an open parent, or else goes to the row it is nested under;
 * Right unfolds a folded parent, or else goes to its first nested row.
 * Undefined when the key has nothing to do there.
 */
export function treeStep(rows: Row[], index: number, by: number): { toggle: string } | { focus: number } | undefined {
  const row = rows[index];
  const branch = row?.branch;
  if (!row || !branch) return undefined;
  if (by > 0) {
    if (branch.children === 0) return undefined;
    return branch.folded ? { toggle: row.key } : { focus: index + 1 };
  }
  if (branch.children > 0 && !branch.folded) return { toggle: row.key };
  if (branch.depth === 0) return undefined;
  const parent = rows.findLastIndex((other, i) => i < index && (other.branch?.depth ?? 0) < branch.depth);
  return parent < 0 ? undefined : { focus: parent };
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
