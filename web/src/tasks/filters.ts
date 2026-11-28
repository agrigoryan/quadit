// Filtering, sorting and grouping tasks, all over the local copy. A filter
// set converts to and from the server's TaskQuery, which is what a saved
// view stores, so views made here work for agents and the other way round.

import type { Collections, Dict } from "@/data/store";
import type { SortBy, Task, TaskQuery } from "@/types/core";
import { type FilterName, FILTERS, type Grouping, GROUPINGS } from "@/tasks/properties";
import { type GroupHead, type GroupSource, ME, type QueryContext, type QuerySource } from "@/tasks/properties/property";

/**
 * What a task list is filtered by: for each property it can be filtered by
 * (tasks/properties FILTERS), the values picked, any one of which a task
 * must have ("none" where it can have none); and an open question, and
 * words in the title or key.
 */
export type Filters = Record<FilterName, string[]> & { openDecision: boolean; text: string };

/** Each filter's values, in the filters' order (which sameFilters relies on). */
function byFilter(values: (p: (typeof FILTERS)[number]) => string[]): Record<FilterName, string[]> {
  const out = {} as Record<FilterName, string[]>;
  for (const p of FILTERS) out[p.name] = values(p);
  return out;
}

export const emptyFilters: Filters = { ...byFilter(() => []), openDecision: false, text: "" };

export function countFilters(f: Filters): number {
  return FILTERS.filter((p) => f[p.name].length > 0).length + (f.openDecision ? 1 : 0);
}

export const sameFilters = (a: Filters, b: Filters) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Builds the test a task must pass. `openDecisionTasks` holds the ids of
 * tasks with an open question; `meId` is whoever looks, whom ME stands for.
 */
export function matcher(
  f: Filters,
  c: Pick<Collections, "statuses">,
  openDecisionTasks: Dict<unknown>,
  meId: string,
): (task: Task) => boolean {
  const text = f.text.trim().toLowerCase();
  const set = FILTERS.filter((p) => f[p.name].length > 0).map((p) => ({
    matches: p.filter.matches,
    picked: f[p.name].map((v) => (v === ME ? meId : v)),
  }));
  return (task) => {
    if (!set.every(({ matches, picked }) => matches(task, picked, c))) return false;
    if (f.openDecision && !openDecisionTasks[task.id]) return false;
    if (text && !task.title.toLowerCase().includes(text) && !task.key.toLowerCase().includes(text)) return false;
    return true;
  };
}

const prioritySort = (p: number) => (p === 0 ? 5 : p);

export function comparer(sort: SortBy): (a: Task, b: Task) => number {
  const byRank = (a: Task, b: Task) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1);
  switch (sort) {
    case "priority":
      return (a, b) => prioritySort(a.priority) - prioritySort(b.priority) || byRank(a, b);
    case "updated":
      return (a, b) => b.updated_at - a.updated_at || byRank(a, b);
    case "created":
      return (a, b) => b.created_at - a.created_at || byRank(a, b);
    case "due":
      return (a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") || byRank(a, b);
    default:
      return byRank;
  }
}

/** A group of a list, or a board's column, with its tasks. */
export interface TaskGroup extends GroupHead {
  kind: Grouping;
  tasks: Task[];
}

/**
 * Splits tasks into groups, in a fixed order with empty groups left out
 * (status groups of the project in view are always shown, so a column or
 * section does not vanish when its last task moves). The board asks to keep
 * the empty ones, so there is always a column to drop a card in. How the
 * groups are made and which a task goes in, each property says
 * (tasks/properties): grouped by label, a task with several labels is in
 * each of their groups.
 */
export function groupTasks(
  tasks: Task[],
  by: Grouping,
  c: GroupSource,
  projectId: string | undefined,
  keepEmpty = false,
): TaskGroup[] {
  const part = GROUPINGS.find((p) => p.name === by)?.group;
  if (!part) return [{ id: "all", title: "", kind: "none", value: "", tasks }];
  const groups = new Map<string, TaskGroup>();
  /** Groups that are shown only when they hold a task: someone removed, a deleted epic. */
  const quiet = new Set<string>();
  for (const { quiet: isQuiet, ...head } of part.groups(c, projectId)) {
    if (groups.has(head.id)) continue;
    groups.set(head.id, { ...head, kind: by, tasks: [] });
    if (isQuiet) quiet.add(head.id);
  }
  const has = (id: string) => groups.has(id);
  for (const task of tasks) for (const id of part.place(task, c, has)) groups.get(id)?.tasks.push(task);
  return [...groups.values()].filter((g) => g.tasks.length > 0 || (keepEmpty && !quiet.has(g.id)));
}

const SORT_TO_QUERY: Record<SortBy, string> = {
  manual: "rank",
  priority: "priority",
  updated: "-updated",
  created: "-created",
  due: "due",
};

/** The filters as the server's TaskQuery, for a saved view. Everything is sent as ids, but for "me", "none" and "outside". */
export function toQuery(f: Filters, projectKey: string | undefined, sort: SortBy): TaskQuery {
  const q: Record<string, unknown> = {};
  if (projectKey) q.project = [projectKey];
  for (const { name, filter } of FILTERS) {
    const values = f[name];
    if (values.length === 0) continue;
    q[filter.word] = filter.holds === "one" ? values[0] : filter.holds === "numbers" ? values.map(Number) : values;
  }
  if (f.openDecision) q.has_open_decision = true;
  if (f.text.trim()) q.q = f.text.trim();
  q.sort = SORT_TO_QUERY[sort];
  return q;
}

export function sortFromQuery(q: TaskQuery | undefined): SortBy | undefined {
  const found = (Object.keys(SORT_TO_QUERY) as SortBy[]).find((k) => SORT_TO_QUERY[k] === q?.sort);
  return found;
}

/**
 * A stored query made safe to read: a view may have been written by hand or
 * by an agent, with one value where a list belongs ("label": "art"). Each
 * list field is given as a list of strings whatever was stored. Returns null
 * when the query is not something a view can show at all.
 */
export function normalizeQuery(raw: unknown): TaskQuery | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const from = raw as Record<string, unknown>;
  const q: Record<string, unknown> = {};
  const scalar = (v: unknown): v is string | number => (typeof v === "string" && v !== "") || typeof v === "number";
  const list = (v: unknown): string[] | null => {
    if (v === undefined || v === null || v === "") return [];
    if (scalar(v)) return [String(v)];
    if (Array.isArray(v) && v.every(scalar)) return v.map(String);
    return null;
  };
  const projects = list(from.project);
  if (!projects) return null;
  if (projects.length) q.project = projects;
  for (const { filter } of FILTERS) {
    const v = from[filter.word];
    if (filter.holds === "one") {
      if (scalar(v)) q[filter.word] = String(v);
      continue;
    }
    const values = list(v);
    if (!values) return null;
    const kept = filter.holds === "numbers" ? values.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : values;
    if (kept.length) q[filter.word] = kept;
  }
  if (from.has_open_decision === true || from.has_open_decision === "true") q.has_open_decision = true;
  if (scalar(from.q)) q.q = String(from.q);
  if (typeof from.sort === "string") q.sort = from.sort;
  return q;
}

/**
 * Reads a saved view's query (one that normalizeQuery has been over). A view
 * may have been made by an agent with names instead of ids ("@coder", "me",
 * "In Progress", "art", "current"), so every reference is looked up both
 * ways; one that matches nothing is dropped. So is one that names something
 * gone (a deleted label, status or epic, a person removed): the server
 * refuses those, and no task can match them.
 */
export function fromQuery(q: TaskQuery | undefined, c: QuerySource): Filters {
  if (!q) return emptyFilters;
  const projectIds = (q.project ?? [])
    .map((ref) => Object.values(c.projects).find((p) => p.id === ref || p.key.toLowerCase() === ref.toLowerCase())?.id)
    .filter(Boolean) as string[];
  const ctx: QueryContext = {
    c,
    inScope: (projectId) => projectIds.length === 0 || !projectId || projectIds.includes(projectId),
  };
  return {
    ...byFilter(({ filter }) => filter.read(q, ctx)),
    openDecision: !!q.has_open_decision,
    text: q.q ?? "",
  };
}

/**
 * What a stored query (one that normalizeQuery has been over) has to lose to
 * be good again: the values fromQuery finds nothing for, because the label,
 * status, epic or cycle was deleted, the person is no longer here, or the
 * status type is no more (waiting). The
 * server refuses a list for a view that names one. Returns the fields to
 * write over the query, each with the values that are left (undefined when
 * none is), or null when nothing is gone.
 */
export function goneFromQuery(q: TaskQuery, c: QuerySource): Partial<TaskQuery> | null {
  /** Whether a word still names something: read alone, it gives some filter a value. */
  const found = (one: Record<string, unknown>) => {
    const f = fromQuery({ project: q.project, ...one }, c);
    return FILTERS.some((p) => f[p.name].length > 0);
  };
  const patch: Record<string, unknown> = {};
  let gone = false;
  for (const { filter } of FILTERS) {
    if (!filter.canBeGone) continue;
    const word = filter.word;
    const stored = (q as Record<string, unknown>)[word];
    if (stored === undefined) continue;
    if (filter.holds === "one") {
      if (found({ [word]: stored })) continue;
      patch[word] = undefined;
      gone = true;
      continue;
    }
    const values = stored as string[];
    const left = values.filter((ref) => found({ [word]: [ref] }));
    if (left.length === values.length) continue;
    patch[word] = left.length > 0 ? left : undefined;
    gone = true;
  }
  return gone ? patch : null;
}
