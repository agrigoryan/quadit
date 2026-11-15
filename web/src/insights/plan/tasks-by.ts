// A project's tasks grouped by their epic or their cycle.

import { useMemo } from "react";
import { useCollection, useLiveTasks } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import { CATEGORIES, type Task } from "@/lib/types";

/** A project's live tasks by the epic or cycle they are in, in status order. */
export function useTasksBy(projectId: string, field: "epic_id" | "cycle_id"): Dict<Task[]> {
  const tasks = useLiveTasks();
  const statuses = useCollection("statuses");
  return useMemo(() => {
    const out: Dict<Task[]> = {};
    for (const task of tasks) {
      const group = task[field];
      if (group && task.project_id === projectId) (out[group] ??= []).push(task);
    }
    const order = (task: Task) => CATEGORIES.indexOf(statuses[task.status_id]?.category ?? "backlog");
    for (const list of Object.values(out)) list.sort((a, b) => order(a) - order(b) || (a.rank < b.rank ? -1 : 1));
    return out;
  }, [tasks, statuses, projectId, field]);
}
