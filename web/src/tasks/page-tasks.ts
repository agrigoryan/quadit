// The tasks a task page shows: those of its projects that pass its filters,
// sorted, and split into the list's groups or the board's columns.

import { useMemo } from "react";
import { useLiveTasks, useOpenDecisions } from "@/lib/selectors";
import { useRestLoaded } from "@/lib/store";
import { isOpenCategory, type Project, type TaskQuery } from "@/lib/types";
import { comparer, groupTasks, matcher, type QuerySource } from "@/tasks/filters";
import type { ViewState } from "@/tasks/view-state";

/** The projects a page is about: its own, or those its view's query names (none: every project). */
function useProjectIds(project: Project | undefined, query: TaskQuery | null, projects: QuerySource["projects"]) {
  return useMemo(() => {
    if (project) return [project.id];
    const keys = (query?.project ?? []).map((k) => k.toLowerCase());
    return Object.values(projects)
      .filter((p) => keys.includes(p.key.toLowerCase()) || keys.includes(p.id))
      .map((p) => p.id);
  }, [project, query, projects]);
}

export function usePageTasks(
  state: ViewState,
  project: Project | undefined,
  query: TaskQuery | null,
  tables: QuerySource,
) {
  const { statuses, members, epics, labels } = tables;
  const all = useLiveTasks();
  const openDecisions = useOpenDecisions();
  const projectIds = useProjectIds(project, query, tables.projects);

  const board = state.layout === "board";
  const tasks = useMemo(() => {
    const match = matcher(state.filters, { statuses }, openDecisions);
    const scoped = new Set(projectIds);
    const inScope = all.filter((task) => (scoped.size === 0 || scoped.has(task.project_id)) && match(task));
    return inScope.sort(comparer(board ? "manual" : state.sort));
  }, [all, state.filters, state.sort, board, statuses, openDecisions, projectIds]);

  // The board keeps every column; the list leaves out sections with nothing in them. Finished work arrives
  // after the rest: until it has, the Done and Canceled sections stay, saying so, instead of looking empty.
  const restLoaded = useRestLoaded();
  const groups = useMemo(() => {
    const by = board ? state.boardGroup : state.group;
    const made = groupTasks(tasks, by, { statuses, members, epics, labels }, project?.id, board || !restLoaded);
    if (board || restLoaded) return made;
    return made.filter((g) => g.tasks.length > 0 || (g.kind === "status" && !isOpenCategory(g.category)));
  }, [tasks, state.group, state.boardGroup, board, restLoaded, statuses, members, epics, labels, project?.id]);

  return { tasks, groups, projectIds, restLoaded };
}
