// Filtering, sorting and grouping tasks, all over the local copy. A filter
// set converts to and from the server's TaskQuery, which is what a saved
// view stores, so views made here work for agents and the other way round.

import { t, tMaybe } from "@/lib/i18n";
import type { Collections, Dict } from "@/lib/store";
import { CATEGORIES, type Category, type GroupBy, type SortBy, type Task, type TaskQuery } from "@/lib/types";

export const NONE = "none";
/** In the "waiting on" filter: tasks that wait on an outside event. */
export const OUTSIDE = "outside";

/** How a page groups its tasks: the server's groupings, and by label. */
export type Grouping = GroupBy | "label";

export interface Filters {
  /** User ids, or "none" for unassigned. */
  assignee: string[];
  status: string[];
  category: Category[];
  label: string[];
  priority: number[];
  /** Epic ids, or "none". */
  epic: string[];
  /** Cycle ids, or "none". */
  cycle: string[];
  /** One user id, "outside" (an outside event), "none" (nobody and nothing), or "". */
  waitingOn: string;
  openDecision: boolean;
  text: string;
}

export const emptyFilters: Filters = {
  assignee: [],
  status: [],
  category: [],
  label: [],
  priority: [],
  epic: [],
  cycle: [],
  waitingOn: "",
  openDecision: false,
  text: "",
};

export type ListFilterKey = "assignee" | "status" | "category" | "label" | "priority" | "epic" | "cycle";
export const LIST_KEYS: ListFilterKey[] = ["assignee", "status", "category", "label", "priority", "epic", "cycle"];

export function countFilters(f: Filters): number {
  return LIST_KEYS.filter((k) => f[k].length > 0).length + (f.waitingOn ? 1 : 0) + (f.openDecision ? 1 : 0);
}

export const sameFilters = (a: Filters, b: Filters) => JSON.stringify(a) === JSON.stringify(b);

const anyOf = (picked: string[], value: string | undefined) => picked.length === 0 || picked.includes(value ?? NONE);

/** Builds the test a task must pass. `openDecisionTasks` holds the ids of tasks with an open question. */
export function matcher(f: Filters, c: Pick<Collections, "statuses">, openDecisionTasks: Dict<unknown>): (task: Task) => boolean {
  const text = f.text.trim().toLowerCase();
  return (task) => {
    if (!anyOf(f.assignee, task.assignee_id)) return false;
    if (f.status.length && !f.status.includes(task.status_id)) return false;
    if (f.category.length && !f.category.includes(c.statuses[task.status_id]?.category as Category)) return false;
    if (f.label.length && !f.label.some((id) => task.label_ids?.includes(id))) return false;
    if (f.priority.length && !f.priority.includes(task.priority)) return false;
    if (!anyOf(f.epic, task.epic_id)) return false;
    if (!anyOf(f.cycle, task.cycle_id)) return false;
    if (f.waitingOn) {
      const outside = task.waiting_outside === true;
      if (f.waitingOn === OUTSIDE ? !outside : f.waitingOn === NONE ? outside || !!task.waiting_on_id : task.waiting_on_id !== f.waitingOn) return false;
    }
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

/** The tables grouping reads; a page passes only these, so it regroups only when one of them changes. */
export type GroupSource = Pick<Collections, "statuses" | "members" | "epics" | "labels">;

/**
 * Splits tasks into groups, in a fixed order with empty groups left out
 * (status groups of the project in view are always shown, so a column or
 * section does not vanish when its last task moves). The board asks to keep
 * the empty ones, so there is always a column to drop a card in. Grouped by
 * label, a task with several labels is in each of their groups.
 */
export function groupTasks(tasks: Task[], by: Grouping, c: GroupSource, projectId: string | undefined, keepEmpty = false): TaskGroup[] {
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
        .filter((s) => s.project_id === projectId && !s.deleted_at)
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
      .filter((l) => !l.deleted_at && (!l.project_id || !projectId || l.project_id === projectId))
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
    const members = Object.values(c.members).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "person" ? -1 : 1));
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
    (groups.get(key) ?? (groups.get(NONE) as TaskGroup)).tasks.push(task);
  }
  return shown();
}

/** The tables a stored query's names are looked up in. */
export type QuerySource = Pick<Collections, "projects" | "members" | "statuses" | "labels" | "epics" | "cycles">;

const SORT_TO_QUERY: Record<SortBy, string> = { manual: "rank", priority: "priority", updated: "-updated", created: "-created", due: "due" };

/** The filters as the server's TaskQuery, for a saved view. Everything is sent as ids. */
export function toQuery(f: Filters, projectKey: string | undefined, sort: SortBy): TaskQuery {
  const q: TaskQuery = {};
  if (projectKey) q.project = [projectKey];
  if (f.assignee.length) q.assignee = f.assignee;
  if (f.status.length) q.status = f.status;
  if (f.category.length) q.category = f.category;
  if (f.label.length) q.label = f.label;
  if (f.priority.length) q.priority = f.priority;
  if (f.epic.length) q.epic = f.epic;
  if (f.cycle.length) q.cycle = f.cycle;
  if (f.waitingOn) q.waiting_on = f.waitingOn;
  if (f.openDecision) q.has_open_decision = true;
  if (f.text.trim()) q.q = f.text.trim();
  q.sort = SORT_TO_QUERY[sort];
  return q;
}

export function sortFromQuery(q: TaskQuery | undefined): SortBy | undefined {
  const found = (Object.keys(SORT_TO_QUERY) as SortBy[]).find((k) => SORT_TO_QUERY[k] === q?.sort);
  return found;
}

const QUERY_LISTS = ["project", "assignee", "status", "category", "label", "epic", "cycle"] as const;

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
  const q: TaskQuery = {};
  const scalar = (v: unknown): v is string | number => (typeof v === "string" && v !== "") || typeof v === "number";
  const list = (v: unknown): string[] | null => {
    if (v === undefined || v === null || v === "") return [];
    if (scalar(v)) return [String(v)];
    if (Array.isArray(v) && v.every(scalar)) return v.map(String);
    return null;
  };
  for (const field of QUERY_LISTS) {
    const values = list(from[field]);
    if (!values) return null;
    if (values.length) q[field] = values;
  }
  const priority = list(from.priority);
  if (!priority) return null;
  const numbers = priority.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 4);
  if (numbers.length) q.priority = numbers;
  if (scalar(from.waiting_on)) q.waiting_on = String(from.waiting_on);
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
export function fromQuery(q: TaskQuery | undefined, c: QuerySource, meId: string, today: string): Filters {
  if (!q) return emptyFilters;
  const low = (s: string) => s.toLowerCase();
  const projectIds = (q.project ?? [])
    .map((ref) => Object.values(c.projects).find((p) => p.id === ref || low(p.key) === low(ref))?.id)
    .filter(Boolean) as string[];
  const inScope = (projectId: string | undefined) => projectIds.length === 0 || !projectId || projectIds.includes(projectId);

  const member = (ref: string): string | undefined => {
    if (ref === NONE) return NONE;
    if (ref === OUTSIDE) return OUTSIDE;
    if (ref === "me") return meId;
    const handle = low(ref.replace(/^@/, ""));
    return Object.values(c.members).find((m) => !m.removed_at && (m.user_id === ref || low(m.handle) === handle))?.user_id;
  };
  const byName = <T extends { id: string; name: string; project_id?: string; deleted_at?: number }>(table: Dict<T>, ref: string): string[] =>
    Object.values(table)
      .filter((row) => !row.deleted_at && (row.id === ref || low(row.name) === low(ref)) && inScope(row.project_id))
      .map((row) => row.id);
  const cycle = (ref: string): string[] => {
    if (ref === NONE) return [NONE];
    const rows = Object.values(c.cycles)
      .filter((cy) => !cy.deleted_at && inScope(cy.project_id))
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    if (ref === "current") return rows.filter((cy) => cy.starts_on <= today && today <= cy.ends_on).map((cy) => cy.id);
    if (ref === "next") return rows.filter((cy) => cy.starts_on > today).slice(0, 1).map((cy) => cy.id);
    return rows.filter((cy) => cy.id === ref || String(cy.number) === ref).map((cy) => cy.id);
  };

  const category = [...(q.category ?? [])] as Category[];
  const status: string[] = [];
  for (const ref of q.status ?? []) {
    const ids = byName(c.statuses, ref);
    if (ids.length) status.push(...ids);
    else if ((CATEGORIES as string[]).includes(low(ref))) category.push(low(ref) as Category);
  }

  return {
    assignee: (q.assignee ?? []).map(member).filter(Boolean) as string[],
    status,
    category: category.filter((cat) => CATEGORIES.includes(cat)),
    label: (q.label ?? []).flatMap((ref) => byName(c.labels, ref)),
    priority: q.priority ?? [],
    epic: (q.epic ?? []).flatMap((ref) => (ref === NONE ? [NONE] : byName(c.epics, ref))),
    cycle: (q.cycle ?? []).flatMap(cycle),
    waitingOn: (q.waiting_on && member(q.waiting_on)) || "",
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
  const read = (one: TaskQuery) => fromQuery({ project: q.project, ...one }, c, meId, today);
  const found = {
    assignee: (ref: string) => read({ assignee: [ref] }).assignee.length > 0,
    status: (ref: string) => {
      const f = read({ status: [ref] });
      return f.status.length > 0 || f.category.length > 0;
    },
    label: (ref: string) => read({ label: [ref] }).label.length > 0,
    epic: (ref: string) => read({ epic: [ref] }).epic.length > 0,
    // "current" and "next" name no cycle on some days; nothing is gone then.
    cycle: (ref: string) => ref === "current" || ref === "next" || read({ cycle: [ref] }).cycle.length > 0,
  };
  const patch: Partial<TaskQuery> = {};
  let gone = false;
  for (const field of Object.keys(found) as (keyof typeof found)[]) {
    const values = q[field] ?? [];
    const left = values.filter(found[field]);
    if (left.length === values.length) continue;
    patch[field] = left.length > 0 ? left : undefined;
    gone = true;
  }
  if (q.waiting_on && !read({ waiting_on: q.waiting_on }).waitingOn) {
    patch.waiting_on = undefined;
    gone = true;
  }
  return gone ? patch : null;
}
