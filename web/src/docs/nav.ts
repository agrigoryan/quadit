// Going places from code that has no router around it: the chips inside the
// editor are also drawn outside the page (when their block is copied), where
// router hooks do not work. The docs routes keep this pointed at the router.

import type { Location, NavigateFunction } from "react-router";
import { getState } from "@/lib/store";

let navigate: NavigateFunction | null = null;
let location: Location | null = null;

export function setNavigator(nav: NavigateFunction | null, at: Location | null) {
  navigate = nav;
  location = at;
}

export const docPath = (id: string) => `/${getState().slug}/docs/${id}`;

export function openDoc(id: string) {
  if (navigate) void navigate(docPath(id));
  else window.location.assign(docPath(id));
}

/** Opens a task's panel over the page that is showing. */
export function openTask(key: string) {
  const path = `/${getState().slug}/task/${key}`;
  if (navigate) void navigate(path, { state: { background: location } });
  else window.location.assign(path);
}
