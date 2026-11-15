// Going places from code that has no router around it: the chips inside the
// editor are also drawn outside the page (when their block is copied), where
// router hooks do not work. The docs routes keep this pointed at the router.

import { type Location, matchPath, type NavigateFunction } from "react-router";
import { getLookupEvenIfGone, projectByKey } from "@/lib/selectors";
import { getState } from "@/lib/store";
import { docPath } from "@/docs/area";
import { inProject } from "@/docs/data";
import { isTaskPath, taskPath } from "@/lib/task-link";

let navigate: NavigateFunction | null = null;
let location: Location | null = null;

export function setNavigator(nav: NavigateFunction | null, at: Location | null) {
  navigate = nav;
  location = at;
}

/** The project whose Docs are on screen, going by the address. */
function projectOnScreen() {
  // An archived project's Docs still open, as the docs routes find it (useProjectByKey).
  return projectByKey(
    getLookupEvenIfGone("projects"),
    matchPath("/:ws/p/:key/docs/*", window.location.pathname)?.params.key,
  );
}

/** Opens a page: in the Docs of the project on screen when it is one of that project's pages, else in the workspace's. */
export function openDoc(id: string) {
  const project = projectOnScreen();
  const path = docPath(
    getState().slug,
    id,
    project && inProject(getLookupEvenIfGone("docs"), id, project.id) ? project : undefined,
  );
  if (navigate) void navigate(path);
  else window.location.assign(path);
}

/** A panel already open over the page gives its place to the next task (see lib/task-link.ts). */
const panelOpen = () => isTaskPath(window.location.pathname);

/** Opens a task's panel over the page that is showing. */
export function openTask(key: string) {
  const path = taskPath(getState().slug, key);
  if (navigate) void navigate(path, { state: { background: location }, replace: panelOpen() });
  else window.location.assign(path);
}

/** Opens a task's panel at one of its decisions. */
export function openDecision(key: string, decisionId: string) {
  const anchor = `decision-${decisionId}`;
  const path = `${taskPath(getState().slug, key)}#${anchor}`;
  if (!navigate) return window.location.assign(path);
  void navigate(path, { state: { background: location }, replace: panelOpen() });
  // The panel draws the task a moment after the address changes: bring the decision into view once it is there.
  let tries = 0;
  const seek = () => {
    const el = document.getElementById(anchor);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    else if (++tries < 40) setTimeout(seek, 75);
  };
  setTimeout(seek, 0);
}
