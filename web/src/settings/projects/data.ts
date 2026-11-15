// What project settings read beyond lib/selectors.

import { useMemo } from "react";
import { useArchived, useLiveTasks } from "@/lib/selectors";
import type { Task } from "@/types/core";

/**
 * The tasks out of the trash: live ones and archived ones. The counts on
 * projects, statuses and labels include archived tasks, since they still
 * have their project, status and labels and come back when unarchived; a
 * trashed task is not counted.
 */
export function useTasksOutOfTrash(): Task[] {
  const live = useLiveTasks();
  const archived = useArchived("tasks");
  return useMemo(() => [...live, ...archived], [live, archived]);
}
