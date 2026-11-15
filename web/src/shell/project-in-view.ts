// The project the screen is about: where a new task goes, and which
// project's list "G then T" opens. A page open in the workspace's Docs
// brings its project into view as an open task does.

import { type Location, matchPath } from "react-router";
import { findTaskByKey } from "@/lib/selectors";
import { getState } from "@/lib/store";
import type { Project } from "@/lib/types";

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
  const { c } = getState();
  const projects = Object.values(c.projects).filter((p) => !p.deleted_at && !p.archived_at);
  const taskKey = matchPath("/:ws/task/:key", location.pathname)?.params.key;
  const pagePath = taskKey ? (pageUnder(location)?.pathname ?? "") : location.pathname;
  const key = matchPath("/:ws/p/:key/*", pagePath)?.params.key?.toUpperCase();
  const task = taskKey ? findTaskByKey(c.tasks, taskKey) : undefined;
  const docId = matchPath("/:ws/docs/:id", pagePath)?.params.id;
  const doc = docId ? (c.docs[docId] as { project_id?: string } | undefined) : undefined;
  const named =
    projects.find((p) => p.id === task?.project_id) ??
    projects.find((p) => p.key === key) ??
    projects.find((p) => p.id === doc?.project_id);
  if (named) lastId = named.id;
  return (
    named ??
    projects.find((p) => p.id === lastId) ??
    projects.sort((a, b) => ((a.rank ?? "") < (b.rank ?? "") ? -1 : 1))[0]
  );
}
