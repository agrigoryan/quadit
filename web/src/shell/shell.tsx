import { lazy, type ReactNode, Suspense } from "react";
import { type Location, matchPath, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { CommandPalette } from "@/palette/palette";
import { ShortcutsSheet } from "@/palette/shortcuts";
import { TaskPanel } from "@/detail/task-panel";
import { useHotkeys } from "@/lib/hotkeys";
import { findTaskByKey } from "@/lib/selectors";
import { getState, useStore } from "@/lib/store";
import { ui, useUi } from "@/lib/ui-state";
import { CyclesPage } from "@/pages/cycles";
import { EpicsPage } from "@/pages/epics";
import { InboxPage } from "@/pages/inbox";
import { MyWorkPage } from "@/pages/my-work";
import { TrashPage } from "@/pages/trash";
import { insightPaths } from "@/insights/paths";
import { NotFoundPage } from "@/shell/placeholders";
import { Loading } from "@/ui/spinner";
import { Sidebar } from "@/shell/sidebar";
import { TopBar } from "@/shell/topbar";
import { CreateTaskDialog } from "@/tasks/create-task";
import { ProjectTasksPage, ViewPage } from "@/tasks/tasks-page";

// The larger parts of the app are fetched when first opened.
const DocsRoutes = lazy(() => import("@/docs/routes"));
const SettingsRoutes = lazy(() => import("@/settings/routes"));
const InsightRoutes = lazy(() => import("@/insights/routes"));

function Later({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

/** The project a new task should default to, given what is on screen. */
function projectInView(pagePath: string, taskKey: string | undefined): string | undefined {
  const { c } = getState();
  if (taskKey) {
    const task = findTaskByKey(c.tasks, taskKey);
    if (task) return task.project_id;
  }
  const key = matchPath("/:ws/p/:key/*", pagePath)?.params.key;
  const projects = Object.values(c.projects).filter((p) => !p.deleted_at && !p.archived_at);
  return (projects.find((p) => p.key === key) ?? projects.sort((a, b) => ((a.rank ?? "") < (b.rank ?? "") ? -1 : 1))[0])?.id;
}

/**
 * The frame of a workspace: sidebar, top bar, the page, and the task panel.
 *
 * A task opens at /:ws/task/:key as a panel over the page it was opened
 * from. That page travels in the link's state as `background`; a task
 * opened from a bare link gets its project's list behind it.
 */
export function Shell() {
  const slug = useStore((s) => s.slug);
  const location = useLocation();
  const navigate = useNavigate();
  const newTask = useUi((s) => s.newTask);

  const taskKey = matchPath("/:ws/task/:key", location.pathname)?.params.key;
  const background = (location.state as { background?: Location } | null)?.background;
  const projectKey = taskKey?.split("-")[0];
  const fallback = `/${slug}/${projectKey ? `p/${projectKey.toUpperCase()}/tasks` : "my-work"}`;
  const page: Location | string = taskKey ? (background ?? fallback) : location;
  const pagePath = typeof page === "string" ? page : page.pathname;

  const openNewTask = () => ui.newTask({ projectId: projectInView(pagePath, taskKey) });
  const closePanel = () => navigate(typeof page === "string" ? page : page.pathname + page.search);

  useHotkeys(
    {
      "mod+k": (e) => {
        e.preventDefault();
        ui.setPalette(!useUi.getState().paletteOpen);
      },
      c: (e) => {
        e.preventDefault();
        openNewTask();
      },
      "?": () => ui.setShortcuts(true),
    },
    { layer: "global" },
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onNewTask={openNewTask} />
        <main className="relative min-h-0 flex-1 overflow-hidden bg-surface">
          <Routes location={page}>
            <Route index element={<Navigate to="my-work" replace />} />
            <Route path="my-work" element={<MyWorkPage />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="p/:key/tasks" element={<ProjectTasksPage layout="list" />} />
            <Route path="p/:key/board" element={<ProjectTasksPage layout="board" />} />
            <Route path="p/:key/epics" element={<EpicsPage />} />
            <Route path="p/:key/cycles" element={<CyclesPage />} />
            <Route path="view/:slug" element={<ViewPage />} />
            <Route path="docs/*" element={<Later><DocsRoutes /></Later>} />
            <Route path="settings/*" element={<Later><SettingsRoutes /></Later>} />
            {insightPaths.map((path) => (
              <Route key={path} path={path} element={<Later><InsightRoutes /></Later>} />
            ))}
            <Route path="trash" element={<TrashPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
      {taskKey && <TaskPanel key={taskKey.toUpperCase()} taskKey={taskKey.toUpperCase()} onClose={closePanel} />}
      <CommandPalette />
      <ShortcutsSheet />
      {newTask && <CreateTaskDialog draft={newTask} />}
    </div>
  );
}
