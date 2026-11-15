/**
 * The paths the insights part of the app answers, under /:ws/. They live
 * here, apart from the pages, so the shell can route to them without
 * loading the pages.
 */
export const insightPaths = [
  "dashboard",
  "agents",
  "decisions",
  "p/:key/timeline",
  "p/:key/epics/:id",
  "p/:key/cycles/:id",
];
