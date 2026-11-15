// Reads of the store that the tasks folder needs more than once and that
// lib/selectors.ts does not offer, and the reads of the server it makes
// with TanStack Query (their keys are here).

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useCan } from "@/lib/access";
import { api, workspacePath } from "@/lib/api";
import { inWorkspace } from "@/lib/query";
import { getRows, sortByRank, useProjects, useSlug } from "@/lib/selectors";
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

/**
 * How many tasks have a status, as the server counts them when the status is
 * deleted: those in use and archived (`kept`), and those in the trash. The
 * workspace's copy cannot say: it holds the trash only once the trash page
 * has read it.
 */
export function useStatusTaskCount(statusId: string) {
  const slug = useSlug();
  return useQuery({
    queryKey: [...inWorkspace(slug), "status-task-count", statusId],
    queryFn: async ({ signal }) => {
      const count = (more: string) =>
        api
          .get<{ count: number }>(
            workspacePath(slug, `/tasks?status=${encodeURIComponent(statusId)}&count=1&${more}`),
            signal,
          )
          .then((out) => out.count);
      const [kept, trashed] = await Promise.all([count("archived=1"), count("trash=1")]);
      return { kept, trashed };
    },
  });
}
