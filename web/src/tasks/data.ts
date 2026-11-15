// Reads of the store that the tasks folder needs more than once and that
// lib/selectors.ts does not offer.

import { useMemo } from "react";
import { useCan } from "@/lib/access";
import { getRows, sortByRank, useProjects } from "@/lib/selectors";
import type { Project, Status } from "@/lib/types";

/** statusesOf outside a component: a project's live statuses in rank order. */
export function projectStatuses(projectId: string): Status[] {
  return sortByRank(getRows("statuses").filter((s) => s.project_id === projectId));
}

/** The projects the signed-in member may create tasks in: none for one who is read-only. */
export function useCreatableProjects(): Project[] {
  const projects = useProjects();
  const can = useCan();
  return useMemo(() => projects.filter((p) => can.edit(p.id)), [projects, can]);
}
