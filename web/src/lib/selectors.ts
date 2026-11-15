// The read interface of the store: components and actions read rows through
// here, never through `collections` directly.
//
// Every list here holds live rows only: not in the trash (`deleted_at`), not
// archived (`archived_at`: a task, a project, a page, an inbox item), not
// removed from the workspace (`removed_at`: a member). What is gone is
// reached only through a selector that says so: useTrashed for the trash
// pages, the EvenIfGone lookups for a trashed task's own page and for
// history that must still name a deleted thing ("status Review (deleted)").
//
// Each hook returns a stable value until the rows it depends on change, so a
// list re-renders only when it must: an answer is remembered against the
// identity of the table it came from, and the store copies a table only when
// one of its rows changes (lib/apply.ts).

import { useMemo } from "react";
import { type Collections, type Dict, getState, type StoreState, useStore } from "@/lib/store";
import {
  type Cycle,
  type Decision,
  type Epic,
  isCanceledCategory,
  isDoneCategory,
  type Label,
  type Member,
  type Project,
  type Status,
  type Task,
  type Template,
  type View,
} from "@/types/core";

/** A row of one collection. */
export type Row<K extends keyof Collections> = Collections[K][string];

/** The fields that put a row out of use. A row type has those of them that apply to it. */
interface Lifecycle {
  deleted_at?: number;
  archived_at?: number;
  removed_at?: number;
}

/** Whether a row is in use: not in the trash, not archived, not removed from the workspace. */
export function isLive(row: object): boolean {
  const r = row as Lifecycle;
  return !r.deleted_at && !r.archived_at && !r.removed_at;
}

const byRank = (a: { rank?: string }, b: { rank?: string }) => ((a.rank ?? "") < (b.rank ?? "") ? -1 : 1);
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * Remembers an answer per table: the same table gives back the same array
 * or object. Every reader shares it, so it is frozen: sorting it in place
 * throws instead of reordering everyone's list. Copy it first.
 */
function perTable<T extends object, Out extends object>(compute: (table: T) => Out): (table: T) => Out {
  const memo = new WeakMap<T, Out>();
  return (table) => {
    let out = memo.get(table);
    if (out === undefined) {
      out = Object.freeze(compute(table)) as Out;
      memo.set(table, out);
    }
    return out;
  };
}

const liveList = perTable((table: Dict<object>) => Object.values(table).filter(isLive));
const liveTable = perTable((table: Dict<object>) => {
  const out: Dict<object> = {};
  for (const [id, row] of Object.entries(table)) if (isLive(row)) out[id] = row;
  return out;
});
const trashedList = perTable((table: Dict<object>) =>
  Object.values(table)
    .filter((row) => !!(row as Lifecycle).deleted_at)
    .sort((a, b) => ((b as Lifecycle).deleted_at ?? 0) - ((a as Lifecycle).deleted_at ?? 0)),
);
const archivedList = perTable((table: Dict<object>) =>
  Object.values(table).filter((row) => !(row as Lifecycle).deleted_at && !!(row as Lifecycle).archived_at),
);

const tableOf = <K extends keyof Collections>(s: StoreState, name: K) => s.collections[name] as Dict<Row<K>>;

/** The live rows of a collection, in no order. */
export function useRows<K extends keyof Collections>(name: K): Row<K>[] {
  return useStore((s) => liveList(tableOf(s, name)) as Row<K>[]);
}

/** useRows outside a component (an action, a key handler). */
export function getRows<K extends keyof Collections>(name: K): Row<K>[] {
  return liveList(tableOf(getState(), name)) as Row<K>[];
}

/** One live row by id (a member by user id); undefined when it is gone. */
export function useRow<K extends keyof Collections>(name: K, id: string | undefined): Row<K> | undefined {
  return useStore((s) => {
    const row = id ? tableOf(s, name)[id] : undefined;
    return row && isLive(row) ? row : undefined;
  });
}

/** useRow outside a component. */
export function getRow<K extends keyof Collections>(name: K, id: string | undefined): Row<K> | undefined {
  const row = id ? tableOf(getState(), name)[id] : undefined;
  return row && isLive(row) ? row : undefined;
}

/**
 * One row by id whatever became of it: for what must still show a thing
 * that is gone (a trashed task's own page, the name of a deleted status in
 * a task's history, a removed member's name on what they wrote).
 */
export function useRowEvenIfGone<K extends keyof Collections>(name: K, id: string | undefined): Row<K> | undefined {
  return useStore((s) => (id ? tableOf(s, name)[id] : undefined));
}

/** useRowEvenIfGone outside a component. */
export function getRowEvenIfGone<K extends keyof Collections>(name: K, id: string | undefined): Row<K> | undefined {
  return id ? tableOf(getState(), name)[id] : undefined;
}

/**
 * The live rows of a collection by id, for looking up many ids at once (the
 * status of each task in a list). A gone row is not in it. To show what
 * gone rows are called, use useLookupEvenIfGone.
 */
export function useLookup<K extends keyof Collections>(name: K): Dict<Row<K>> {
  return useStore((s) => liveTable(tableOf(s, name)) as Dict<Row<K>>);
}

/**
 * Every row of a collection by id, gone ones included: for following ids
 * that may name something gone (the project of a task in an archived
 * project, a removed member who wrote a comment). Never list from it.
 */
export function useLookupEvenIfGone<K extends keyof Collections>(name: K): Dict<Row<K>> {
  return useStore((s) => tableOf(s, name));
}

/**
 * useLookupEvenIfGone outside a component: for an action that must follow
 * or find rows in the trash (restoring a page with those trashed with it).
 */
export function getLookupEvenIfGone<K extends keyof Collections>(name: K): Dict<Row<K>> {
  return tableOf(getState(), name);
}

/** The rows of a collection in the trash, the most recently trashed first. */
export function useTrashed<K extends keyof Collections>(name: K): Row<K>[] {
  return useStore((s) => trashedList(tableOf(s, name)) as Row<K>[]);
}

/** The archived rows of a collection (not those in the trash), in no order. */
export function useArchived<K extends keyof Collections>(name: K): Row<K>[] {
  return useStore((s) => archivedList(tableOf(s, name)) as Row<K>[]);
}

/**
 * The signed-in member. It is there only because the shell draws no page
 * until the store is ready (shell/workspace.tsx); outside that gate it is
 * undefined despite the type.
 */
export function useMe(): Member {
  return useStore((s) => s.me) as Member;
}

export const useSlug = () => useStore((s) => s.slug);

const projectList = perTable((projects: Dict<Project>) => [...liveList(projects)].sort(byRank) as Project[]);

/** The projects in use, in the order of the sidebar. */
export function useProjects(): Project[] {
  return useStore((s) => projectList(s.collections.projects));
}

/** projectByKey for a component: a project by key, an archived one included (its pages still open); not one in the trash. */
export function useProjectByKey(key: string | undefined): Project | undefined {
  const projects = useStore((s) => s.collections.projects);
  return useMemo(() => projectByKey(projects, key), [projects, key]);
}

/** useProjectByKey outside a component. */
export function getProjectByKey(key: string | undefined): Project | undefined {
  return projectByKey(getState().collections.projects, key);
}

/** The project with this key, case aside, an archived one included; not one in the trash. */
export function projectByKey(projects: Dict<Project>, key: string | undefined): Project | undefined {
  if (!key) return undefined;
  const low = key.toLowerCase();
  return Object.values(projects).find((p) => !p.deleted_at && p.key.toLowerCase() === low);
}

export function statusesOf(statuses: Dict<Status>, projectId: string): Status[] {
  return (liveList(statuses) as Status[]).filter((s) => s.project_id === projectId).sort(byRank);
}

export function useStatuses(projectId: string | undefined): Status[] {
  const statuses = useStore((s) => s.collections.statuses);
  return useMemo(() => (projectId ? statusesOf(statuses, projectId) : []), [statuses, projectId]);
}

/** Labels a task in this project can carry: the project's own and the workspace's. */
export function useLabels(projectId: string | undefined): Label[] {
  const labels = useRows("labels");
  return useMemo(
    () => labels.filter((l) => !l.project_id || !projectId || l.project_id === projectId).sort(byName),
    [labels, projectId],
  );
}

/** Everyone who can be assigned or mentioned: people first, then agents. */
export function useMembers(): Member[] {
  const members = useRows("members");
  return useMemo(
    () =>
      [...members].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "person" ? -1 : 1)),
    [members],
  );
}

/**
 * A member by user id, one removed from the workspace included: a person's
 * name stays on what they did. To ask whether they are still here, use
 * useRow("members", id).
 */
export function useMember(userId: string | undefined): Member | undefined {
  return useRowEvenIfGone("members", userId);
}

export function useEpics(projectId: string | undefined): Epic[] {
  const epics = useRows("epics");
  return useMemo(() => epics.filter((e) => !projectId || e.project_id === projectId).sort(byRank), [epics, projectId]);
}

export function useCycles(projectId: string | undefined): Cycle[] {
  const cycles = useRows("cycles");
  return useMemo(
    () =>
      cycles
        .filter((c) => !projectId || c.project_id === projectId)
        .sort((a, b) => a.starts_on.localeCompare(b.starts_on)),
    [cycles, projectId],
  );
}

export function useTemplates(projectId: string | undefined): Template[] {
  const templates = useRows("templates");
  return useMemo(
    () => templates.filter((tp) => !tp.project_id || tp.project_id === projectId).sort(byName),
    [templates, projectId],
  );
}

const viewList = perTable((views: Dict<View>) => [...liveList(views)].sort(byRank) as View[]);

export function useViews(): View[] {
  return useStore((s) => viewList(s.collections.views));
}

const taskKeys = perTable((tasks: Dict<Task>) => {
  const out = new Map<string, Task>();
  for (const task of Object.values(tasks)) if (!out.has(task.key)) out.set(task.key, task);
  return out;
});

/** The task with this key (case aside) whatever became of it. */
function taskByKey(tasks: Dict<Task>, key: string | undefined): Task | undefined {
  return key ? taskKeys(tasks).get(key.toUpperCase()) : undefined;
}

/** A live task by key; one in the trash or the archive is not found. */
export function useTaskByKey(key: string | undefined): Task | undefined {
  return useStore((s) => {
    const task = taskByKey(s.collections.tasks, key);
    return task && isLive(task) ? task : undefined;
  });
}

/** useTaskByKey outside a component. */
export function getTaskByKey(key: string | undefined): Task | undefined {
  const task = taskByKey(getState().collections.tasks, key);
  return task && isLive(task) ? task : undefined;
}

/**
 * A task by key, in the trash or the archive too: for the task's own page,
 * which shows a trashed task as trashed and an archived one as it is.
 */
export function useTaskByKeyEvenIfGone(key: string | undefined): Task | undefined {
  return useStore((s) => taskByKey(s.collections.tasks, key));
}

/** useTaskByKeyEvenIfGone outside a component. */
export function getTaskByKeyEvenIfGone(key: string | undefined): Task | undefined {
  return taskByKey(getState().collections.tasks, key);
}

/** Tasks that are not in the trash or the archive. */
export function useLiveTasks(): Task[] {
  return useRows("tasks");
}

/** Tasks in the trash, the most recently trashed first. */
export function useTrashedTasks(): Task[] {
  return useTrashed("tasks");
}

const openDecisions = perTable((decisions: Dict<Decision>) => {
  const out: Dict<Decision[]> = {};
  for (const d of liveList(decisions) as Decision[]) if (d.state === "open") (out[d.task_id] ??= []).push(d);
  return out;
});

/** Open decisions, by the task they are in. */
export function useOpenDecisions(): Dict<Decision[]> {
  return useStore((s) => openDecisions(s.collections.decisions));
}

export function useUnreadCount(): number {
  const notifications = useRows("notifications");
  const me = useMe();
  // Only the viewer's own: the page can hold a notice written for someone else.
  return useMemo(
    () => notifications.filter((n) => n.user_id === me.user_id && !n.read_at).length,
    [notifications, me.user_id],
  );
}

export const sortByRank = <T extends { rank?: string }>(rows: T[]): T[] => [...rows].sort(byRank);

/** Remembers the last answer for the last input, so per-row lookups cost one pass per change. */
function memoLast<In, Out>(compute: (input: In) => Out): (input: In) => Out {
  let lastIn: In | undefined;
  let lastOut: Out | undefined;
  return (input) => {
    if (input !== lastIn) {
      lastOut = compute(input);
      lastIn = input;
    }
    return lastOut as Out;
  };
}

const openDecisionAsked = perTable((decisions: Dict<Decision>) => {
  const out: Dict<string[]> = {};
  for (const [taskId, open] of Object.entries(openDecisions(decisions))) {
    out[taskId] = open.map((d) => d.asked_id ?? "");
  }
  return out;
});

/** Whether a task has an open question: "mine" when one is asked of me, "open", or "". */
export function useDecisionFlag(taskId: string): "" | "open" | "mine" {
  return useStore((s) => {
    const asked = openDecisionAsked(s.collections.decisions)[taskId];
    if (!asked) return "";
    return asked.includes(s.me?.user_id ?? "-") ? "mine" : "open";
  });
}

/** Per parent, how many of its sub-tasks are done of those that count: the live ones the sub-task list shows; a canceled one is not work left, nor work done. */
const childProgress = memoLast((input: { tasks: Dict<Task>; statuses: Dict<Status> }) => {
  const out: Dict<{ done: number; total: number }> = {};
  for (const task of Object.values(input.tasks)) {
    if (!task.parent_id || !isLive(task)) continue;
    const category = input.statuses[task.status_id]?.category;
    if (isCanceledCategory(category)) continue;
    const p = (out[task.parent_id] ??= { done: 0, total: 0 });
    p.total++;
    if (isDoneCategory(category)) p.done++;
  }
  return out;
});

let progressInput: { tasks: Dict<Task>; statuses: Dict<Status> } | undefined;

function progressOf(s: { collections: { tasks: Dict<Task>; statuses: Dict<Status> } }, taskId: string) {
  if (
    !progressInput ||
    progressInput.tasks !== s.collections.tasks ||
    progressInput.statuses !== s.collections.statuses
  ) {
    progressInput = { tasks: s.collections.tasks, statuses: s.collections.statuses };
  }
  return childProgress(progressInput)[taskId];
}

/**
 * How many of a task's sub-tasks are done, of how many; undefined when it
 * has none that count. Canceled sub-tasks are left out of both. A row
 * redraws only when one of the two numbers changes.
 */
export function useSubtaskProgress(taskId: string): { done: number; total: number } | undefined {
  const done = useStore((s) => progressOf(s, taskId)?.done ?? 0);
  const total = useStore((s) => progressOf(s, taskId)?.total ?? 0);
  return total > 0 ? { done, total } : undefined;
}
