// Filtering, sorting and grouping tasks, all over the local copy. A filter
// set converts to and from the server's TaskQuery, which is what a saved
// view stores, so views made here work for agents and the other way round.

import { t, tMaybe } from "@/lib/i18n";
import type { Collections, Dict } from "@/lib/store";
import { CATEGORIES, type Category, type GroupBy, type SortBy, type Task, type TaskQuery } from "@/lib/types";
import { type FilterName, FILTERS } from "@/tasks/properties";
import { NONE, type QueryContext, type QuerySource } from "@/tasks/properties/property";

/** How a page groups its tasks: the server's groupings, and by label. */
export type Grouping = GroupBy | "label";

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

/** Builds the test a task must pass. `openDecisionTasks` holds the ids of tasks with an open question. */
export function matcher(
  f: Filters,
  c: Pick<Collections, "statuses">,
  openDecisionTasks: Dict<unknown>,
): (task: Task) => boolean {
  const text = f.text.trim().toLowerCase();
  const set = FILTERS.filter((p) => f[p.name].length > 0);
  return (task) => {
    if (!set.every((p) => p.filter.matches(task, f[p.name], c))) return false;
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

export interface TaskGroup {
  /** Unique within the list. For status groups this is the status id (or the category, across projects). */
  id: string;
  title: string;
  kind: Grouping;
  /** The value the group stands for: a status id or category, a user id, an epic id, a label id, a priority. */
  value: string;
  category?: Category;
  tasks: Task[];
}

/**
 * The tables grouping reads; a page passes only these, so it regroups only
 * when one of them changes. Statuses and labels are the live ones
 * (useLookup); members and epics are every row (useLookupEvenIfGone), so a
 * task still assigned to someone removed, or in a deleted epic, keeps a group
 * under that name.
 */
export type GroupSource = Pick<Collections, "statuses" | "members" | "epics" | "labels">;

/**
 * Splits tasks into groups, in a fixed order with empty groups left out
 * (status groups of the project in view are always shown, so a column or
 * section does not vanish when its last task moves). The board asks to keep
 * the empty ones, so there is always a column to drop a card in. Grouped by
 * label, a task with several labels is in each of their groups.
 */
export function groupTasks(
  tasks: Task[],
  by: Grouping,
  c: GroupSource,
  projectId: string | undefined,
  keepEmpty = false,
): TaskGroup[] {
  if (by === "none") return [{ id: "all", title: "", kind: "none", value: "", tasks }];
  const groups = new Map<string, TaskGroup>();
  /** Groups that are shown only when they hold a task: someone removed, a deleted epic. */
  const quiet = new Set<string>();
  const add = (g: Omit<TaskGroup, "tasks" | "kind">) => {
    if (!groups.has(g.id)) groups.set(g.id, { ...g, kind: by, tasks: [] });
    return groups.get(g.id) as TaskGroup;
  };
  const shown = () => [...groups.values()].filter((g) => g.tasks.length > 0 || (keepEmpty && !quiet.has(g.id)));

  if (by === "status") {
    if (projectId) {
      const own = Object.values(c.statuses)
        .filter((s) => s.project_id === projectId)
        .sort((a, b) => (a.rank < b.rank ? -1 : 1));
      for (const s of own) add({ id: s.id, title: s.name, value: s.id, category: s.category });
      for (const task of tasks) groups.get(task.status_id)?.tasks.push(task);
      return shown();
    }
    // Several projects: their statuses differ, the six categories do not.
    for (const cat of CATEGORIES) add({ id: cat, title: tMaybe(`category.${cat}`), value: cat, category: cat });
    for (const task of tasks) groups.get(c.statuses[task.status_id]?.category ?? "backlog")?.tasks.push(task);
    return shown();
  }

  if (by === "priority") {
    for (const p of [1, 2, 3, 4, 0]) add({ id: String(p), title: tMaybe(`priority.${p}`), value: String(p) });
    for (const task of tasks) groups.get(String(task.priority))?.tasks.push(task);
    return shown();
  }

  if (by === "label") {
    const labels = Object.values(c.labels)
      .filter((l) => !l.project_id || !projectId || l.project_id === projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const l of labels) add({ id: l.id, title: l.name, value: l.id });
    const none = add({ id: NONE, title: t("task.noLabel"), value: NONE });
    for (const task of tasks) {
      let placed = false;
      for (const id of task.label_ids ?? []) {
        const group = groups.get(id);
        if (!group) continue;
        group.tasks.push(task);
        placed = true;
      }
      if (!placed) none.tasks.push(task);
    }
    return shown();
  }

  if (by === "assignee") {
    const members = Object.values(c.members).sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "person" ? -1 : 1,
    );
    for (const m of members) {
      add({ id: m.user_id, title: m.name, value: m.user_id });
      if (m.removed_at || m.suspended_at) quiet.add(m.user_id);
    }
  } else {
    const epics = Object.values(c.epics).sort((a, b) => (a.rank < b.rank ? -1 : 1));
    for (const e of epics) {
      add({ id: e.id, title: e.name, value: e.id });
      if (e.deleted_at || (projectId && e.project_id !== projectId)) quiet.add(e.id);
    }
  }
  add({ id: NONE, title: by === "assignee" ? t("task.unassigned") : t("task.noEpic"), value: NONE });
  for (const task of tasks) {
    const key = (by === "assignee" ? task.assignee_id : task.epic_id) ?? NONE;
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsc needs it: get() may be undefined, and the NONE group was added above
    (groups.get(key) ?? (groups.get(NONE) as TaskGroup)).tasks.push(task);
  }
  return shown();
}

const SORT_TO_QUERY: Record<SortBy, string> = {
  manual: "rank",
  priority: "priority",
  updated: "-updated",
  created: "-created",
  due: "due",
};

/** The filters as the server's TaskQuery, for a saved view. Everything is sent as ids. */
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
export function fromQuery(q: TaskQuery | undefined, c: QuerySource, meId: string, _today?: string): Filters {
  if (!q) return emptyFilters;
  const projectIds = (q.project ?? [])
    .map((ref) => Object.values(c.projects).find((p) => p.id === ref || p.key.toLowerCase() === ref.toLowerCase())?.id)
    .filter(Boolean) as string[];
  const ctx: QueryContext = {
    c,
    meId,
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
 * status, epic or cycle was deleted or the person is no longer here. The
 * server refuses a list for a view that names one. Returns the fields to
 * write over the query, each with the values that are left (undefined when
 * none is), or null when nothing is gone.
 */
export function goneFromQuery(q: TaskQuery, c: QuerySource, meId: string, today: string): Partial<TaskQuery> | null {
  /** Whether a word still names something: read alone, it gives some filter a value. */
  const found = (one: Record<string, unknown>) => {
    const f = fromQuery({ project: q.project, ...one }, c, meId, today);
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
