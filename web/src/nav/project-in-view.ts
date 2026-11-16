// The project the screen is about: where a new task goes, and which
// project's list "G then T" opens. A page open in the workspace's Docs
// brings its project into view as an open task does. An epic's or a
// cycle's page also says the epic or cycle a new task belongs to.

import { type Location, matchPath } from "react-router";
import { getRow, getRowEvenIfGone, getRows, getTaskByKeyEvenIfGone, sortByRank } from "@/data/selectors";
import type { TaskDraft } from "@/lib/ui-state";
import type { Project } from "@/types/core";

/** The project last seen on screen: on a page of no project (the inbox, My work) it is still the one in view. */
let lastId: string | undefined;

/** The page a task panel lies over, if this is a task's address opened over one. */
export const pageUnder = (location: Location) => (location.state as { background?: Location } | null)?.background;

/**
 * The project of the open task, else the project named in the address (of
 * the page under the panel, when a panel is open), else that of the open
 * page of the docs, else the last one that was in view, else the first.
 */
export function projectInView(location: Location): Project | undefined {
  const projects = getRows("projects");
  const taskKey = matchPath("/:ws/task/:key", location.pathname)?.params.key;
  const pagePath = taskKey ? (pageUnder(location)?.pathname ?? "") : location.pathname;
  const key = matchPath("/:ws/p/:key/*", pagePath)?.params.key?.toUpperCase();
  // A trashed or archived task's page still brings its project into view.
  const task = getTaskByKeyEvenIfGone(taskKey);
  const docId = matchPath("/:ws/docs/:id", pagePath)?.params.id;
  const doc = getRowEvenIfGone("docs", docId);
  const named =
    projects.find((p) => p.id === task?.project_id) ??
    projects.find((p) => p.key === key) ??
    projects.find((p) => p.id === doc?.project_id);
  if (named) lastId = named.id;
  return named ?? projects.find((p) => p.id === lastId) ?? sortByRank(projects)[0];
}

/**
 * What a task made here starts with (C, the top bar's New task): the
 * project in view, and on an epic's or a cycle's page that epic or cycle,
 * as the page's own Add task button has it.
 */
export function draftInView(location: Location): TaskDraft {
  const project = projectInView(location);
  if (!project) return {};
  const epicId = matchPath("/:ws/p/:key/epics/:id", location.pathname)?.params.id;
  const cycleId = matchPath("/:ws/p/:key/cycles/:id", location.pathname)?.params.id;
  const epic = getRow("epics", epicId);
  const cycle = getRow("cycles", cycleId);
  if (epic?.project_id === project.id) return { projectId: project.id, epicId: epic.id };
  if (cycle?.project_id === project.id) return { projectId: project.id, cycleId: cycle.id };
  return { projectId: project.id };
}
