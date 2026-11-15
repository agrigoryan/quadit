// How a task is opened. A task has one address, /:ws/task/KEY, and it shows
// two ways. Opened over a page (a click in a list, Space on a row) it is the
// panel at the right, a quick look that leaves the list where it was: the
// page under it travels in the link's state as `background`. Opened bare (a
// pasted address, a link in a notification, a new tab, Enter on a row) it is
// the task's own page.
//
// The panel is one step in the browser's history above its page, whichever
// task it shows: moving it to another task replaces that step, and closing
// it goes back one. So Back closes the panel, and never walks through every
// task that was looked at.

import { createContext, useContext, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { pageUnder } from "@/shell/project-in-view";

export const taskPath = (slug: string, key: string) => `/${slug}/task/${key}`;

const TASK_PATH = /\/task\/[^/]+\/?$/;

/** True for the address of a task, whichever way it shows. */
export const isTaskPath = (pathname: string) => TASK_PATH.test(pathname);

/** True when the app has an earlier step to go back to in this tab. The router numbers its steps in the history's state. */
export const canGoBack = () => ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;

/** The task now in the panel, for the page under it. */
export interface Peek {
  /** Its key, or undefined while no panel is open. */
  key: string | undefined;
  close: () => void;
}

export const PeekContext = createContext<Peek>({ key: undefined, close: () => {} });
export const usePeek = () => useContext(PeekContext);

/**
 * The props of a link to a task: <Link {...useTaskLink(task)}>. A plain
 * click shows the task in the panel over the page that is showing; the
 * address is the task's own, so a click with Cmd or Ctrl, or the middle
 * button, opens its page in a new tab. On a task's own page, links lead to
 * other tasks' pages.
 */
export function useTaskLink(task: Pick<Task, "key">) {
  const slug = useStore((s) => s.slug);
  const location = useLocation();
  const peeking = usePeek().key !== undefined;
  const to = taskPath(slug, task.key);
  // Inside the panel the router's address is the task's, with the page under it in its state.
  const under = pageUnder(location);
  if (under) return { to, state: { background: under }, replace: true };
  if (isTaskPath(location.pathname)) return { to, state: undefined, replace: false };
  return { to, state: { background: location }, replace: peeking };
}

/** Opens a task from a key press or a handler: `peek` in the panel, `page` as its own page. */
export function useTaskNav() {
  const slug = useStore((s) => s.slug);
  const location = useLocation();
  const navigate = useNavigate();
  const peeking = usePeek().key !== undefined;
  return useMemo(() => {
    const under = pageUnder(location);
    const replace = peeking || !!under;
    return {
      peek(key: string) {
        // From a task's own page there is no list to stay on: the next task opens as a page too.
        if (!under && isTaskPath(location.pathname)) return void navigate(taskPath(slug, key));
        void navigate(taskPath(slug, key), { state: { background: under ?? location }, replace });
      },
      page(key: string) {
        void navigate(taskPath(slug, key), { replace });
      },
    };
  }, [slug, location, navigate, peeking]);
}
