// Read the store from components. Each hook returns a stable value until
// the rows it depends on change, so a list re-renders only when it must.

import { useMemo } from "react";
import { type Collections, type Dict, useStore } from "@/lib/store";
import type { Cycle, Decision, Epic, Label, Member, Project, Status, Task, Template, View } from "@/lib/types";

const byRank = (a: { rank?: string }, b: { rank?: string }) => ((a.rank ?? "") < (b.rank ?? "") ? -1 : 1);
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const live = (row: { deleted_at?: number }) => !row.deleted_at;

export function useCollection<K extends keyof Collections>(name: K): Collections[K] {
  return useStore((s) => s.collections[name]);
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

export function useProjects(): Project[] {
  const projects = useCollection("projects");
  return useMemo(
    () =>
      Object.values(projects)
        .filter((p) => live(p) && !p.archived_at)
        .sort(byRank),
    [projects],
  );
}

export function useProjectByKey(key: string | undefined): Project | undefined {
  const projects = useCollection("projects");
  return useMemo(
    () => (key ? Object.values(projects).find((p) => p.key.toLowerCase() === key.toLowerCase()) : undefined),
    [projects, key],
  );
}

export function statusesOf(statuses: Dict<Status>, projectId: string): Status[] {
  return Object.values(statuses)
    .filter((s) => s.project_id === projectId && live(s))
    .sort(byRank);
}

export function useStatuses(projectId: string | undefined): Status[] {
  const statuses = useCollection("statuses");
  return useMemo(() => (projectId ? statusesOf(statuses, projectId) : []), [statuses, projectId]);
}

/** Labels a task in this project can carry: the project's own and the workspace's. */
export function useLabels(projectId: string | undefined): Label[] {
  const labels = useCollection("labels");
  return useMemo(
    () =>
      Object.values(labels)
        .filter((l) => live(l) && (!l.project_id || !projectId || l.project_id === projectId))
        .sort(byName),
    [labels, projectId],
  );
}

/** Everyone who can be assigned or mentioned: people first, then agents. */
export function useMembers(): Member[] {
  const members = useCollection("members");
  return useMemo(
    () =>
      Object.values(members)
        .filter((m) => !m.removed_at)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "person" ? -1 : 1)),
    [members],
  );
}

export function useMember(userId: string | undefined): Member | undefined {
  return useStore((s) => (userId ? s.collections.members[userId] : undefined));
}

export function useEpics(projectId: string | undefined): Epic[] {
  const epics = useCollection("epics");
  return useMemo(
    () =>
      Object.values(epics)
        .filter((e) => live(e) && (!projectId || e.project_id === projectId))
        .sort(byRank),
    [epics, projectId],
  );
}

export function useCycles(projectId: string | undefined): Cycle[] {
  const cycles = useCollection("cycles");
  return useMemo(
    () =>
      Object.values(cycles)
        .filter((c) => live(c) && (!projectId || c.project_id === projectId))
        .sort((a, b) => a.starts_on.localeCompare(b.starts_on)),
    [cycles, projectId],
  );
}

export function useTemplates(projectId: string | undefined): Template[] {
  const templates = useCollection("templates");
  return useMemo(
    () =>
      Object.values(templates)
        .filter((tp) => live(tp) && (!tp.project_id || tp.project_id === projectId))
        .sort(byName),
    [templates, projectId],
  );
}

export function useViews(): View[] {
  const views = useCollection("views");
  return useMemo(() => Object.values(views).filter(live).sort(byRank), [views]);
}

export function useTask(id: string | undefined): Task | undefined {
  return useStore((s) => (id ? s.collections.tasks[id] : undefined));
}

export function findTaskByKey(tasks: Dict<Task>, key: string): Task | undefined {
  const upper = key.toUpperCase();
  for (const task of Object.values(tasks)) if (task.key === upper) return task;
  return undefined;
}

export function useTaskByKey(key: string | undefined): Task | undefined {
  const tasks = useCollection("tasks");
  return useMemo(() => (key ? findTaskByKey(tasks, key) : undefined), [tasks, key]);
}

/** Tasks that are not in the trash or the archive. */
export function useLiveTasks(): Task[] {
  const tasks = useCollection("tasks");
  return useMemo(() => Object.values(tasks).filter((tk) => !tk.deleted_at && !tk.archived_at), [tasks]);
}

/** Open decisions, by the task they are in. */
export function useOpenDecisions(): Dict<Decision[]> {
  const decisions = useCollection("decisions");
  return useMemo(() => {
    const out: Dict<Decision[]> = {};
    for (const d of Object.values(decisions)) {
      if (d.state === "open" && !d.deleted_at) (out[d.task_id] ??= []).push(d);
    }
    return out;
  }, [decisions]);
}

export function useUnreadCount(): number {
  const notifications = useCollection("notifications");
  const me = useMe();
  // Only the viewer's own: the page can hold a notice written for someone else.
  return useMemo(
    () => Object.values(notifications).filter((n) => n.user_id === me.user_id && !n.read_at && !n.archived_at).length,
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

const openDecisionAsked = memoLast((decisions: Dict<Decision>) => {
  const out: Dict<string[]> = {};
  for (const d of Object.values(decisions)) {
    if (d.state === "open" && !d.deleted_at) (out[d.task_id] ??= []).push(d.asked_id ?? "");
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

/** Per parent, how many of its sub-tasks are done of those that count: a canceled one is not work left, nor work done. */
const childProgress = memoLast((input: { tasks: Dict<Task>; statuses: Dict<Status> }) => {
  const out: Dict<{ done: number; total: number }> = {};
  for (const task of Object.values(input.tasks)) {
    if (!task.parent_id || task.deleted_at) continue;
    const category = input.statuses[task.status_id]?.category;
    if (category === "canceled") continue;
    const p = (out[task.parent_id] ??= { done: 0, total: 0 });
    p.total++;
    if (category === "done") p.done++;
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
