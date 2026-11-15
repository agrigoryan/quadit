import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo } from "react";
import { type Location, matchPath, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { useMedia } from "@/decisions/data";
import { ShortcutsSheet } from "@/palette/shortcuts";
import { useHotkeys } from "@/lib/hotkeys";
import { useStore } from "@/lib/store";
import { ui, useUi } from "@/lib/ui-state";
import { InboxPage } from "@/pages/inbox";
import { MyWorkPage } from "@/pages/my-work";
import { TrashPage } from "@/pages/trash";
import { insightPaths } from "@/insights/paths";
import { PageBoundary, PartBoundary } from "@/shell/error-boundary";
import { GoHint, useGoKeys } from "@/shell/go-keys";
import { NotFoundPage } from "@/shell/placeholders";
import { pageUnder, projectInView } from "@/shell/project-in-view";
import { Loading } from "@/ui/spinner";
import { Sidebar } from "@/shell/sidebar";
import { TopBar } from "@/shell/topbar";
import { UploadsIndicator } from "@/shell/uploads";
import { canGoBack, type Peek, PeekContext, taskPath } from "@/tasks/task-link";
import { ProjectTasksPage, ViewPage } from "@/tasks/tasks-page";

// The larger parts of the app are fetched when first opened.
const DocsRoutes = lazy(() => import("@/docs/routes"));
const SettingsRoutes = lazy(() => import("@/settings/routes"));
const InsightRoutes = lazy(() => import("@/insights/routes"));
const EpicsPage = lazy(() => import("@/pages/epics").then((m) => ({ default: m.EpicsPage })));
const CyclesPage = lazy(() => import("@/pages/cycles").then((m) => ({ default: m.CyclesPage })));

// So are the parts drawn over the page, and a task's own page. These are
// also fetched ahead, once the first page is up, so that opening a task,
// the palette or the new-task dialog does not wait on the network.
const loadTaskPanel = () => import("@/detail/task-panel");
const loadTaskPage = () => import("@/detail/task-page");
const loadPalette = () => import("@/palette/palette");
const loadCreateTask = () => import("@/tasks/create-task");
const TaskPanel = lazy(() => loadTaskPanel().then((m) => ({ default: m.TaskPanel })));
const TaskPage = lazy(() => loadTaskPage().then((m) => ({ default: m.TaskPage })));
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })));
const CreateTaskDialog = lazy(() => loadCreateTask().then((m) => ({ default: m.CreateTaskDialog })));

function fetchAhead() {
  for (const load of [loadTaskPanel, loadTaskPage, loadPalette, loadCreateTask]) load().catch(() => {});
}

function Later({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

/** One part drawn over the page. Each waits and fails by itself, so opening one never hides another. */
function Part({ on, children }: { on: string | boolean; children: ReactNode }) {
  return (
    <PartBoundary resetKey={String(on)}>
      <Suspense fallback={null}>{children}</Suspense>
    </PartBoundary>
  );
}

/**
 * The frame of a workspace: sidebar, top bar, the page, and the task panel.
 *
 * A task's address is /:ws/task/:key (tasks/task-link.ts). Opened from a
 * list it is a panel over that list, which travels in the link's state as
 * `background`. Opened bare (a pasted address, a link from a notification,
 * Enter in a list) it is the task's own page. A phone has room for one
 * thing at a time: there the task always covers the screen, with its
 * project's list behind it when it was opened bare.
 */
export function Shell() {
  const slug = useStore((s) => s.slug);
  const location = useLocation();
  const navigate = useNavigate();
  const newTask = useUi((s) => s.newTask);
  const paletteOpen = useUi((s) => s.paletteOpen);

  useEffect(() => {
    const timer = setTimeout(fetchAhead, 1500);
    return () => clearTimeout(timer);
  }, []);

  const taskKey = matchPath("/:ws/task/:key", location.pathname)?.params.key?.toUpperCase();
  const background = pageUnder(location);
  const phone = useMedia("(max-width: 767px)");
  const inPanel = !!taskKey && (!!background || phone);
  const projectKey = taskKey?.split("-")[0];
  const fallback = `/${slug}/${projectKey ? `p/${projectKey}/tasks` : "my-work"}`;
  const page: Location | string = inPanel ? (background ?? fallback) : location;
  const pagePath = typeof page === "string" ? page : page.pathname;

  const openNewTask = () => ui.newTask({ projectId: projectInView(location)?.id });
  // The panel is one step above its page in the history: closing it is going back that step.
  const closePanel = useCallback(() => void (background && canGoBack() ? navigate(-1) : navigate(fallback)), [background, fallback, navigate]);
  // The page's place is taken by the panel's, so one step back from the page is the list again.
  const expandPanel = () => taskKey && void navigate(taskPath(slug, taskKey), { replace: !!background });
  // From a task's page: back to where the person was, or to the task's list when they arrived by its address.
  const leavePage = () => void (canGoBack() ? navigate(-1) : navigate(fallback));
  const peek = useMemo<Peek>(() => ({ key: inPanel ? taskKey : undefined, close: closePanel }), [inPanel, taskKey, closePanel]);

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
  useGoKeys();

  return (
    <PeekContext value={peek}>
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onNewTask={openNewTask} />
        <main className="relative min-h-0 flex-1 overflow-hidden bg-surface">
          <PageBoundary resetKey={pagePath}>
          <Routes location={page}>
            <Route index element={<Navigate to="my-work" replace />} />
            <Route path="my-work" element={<MyWorkPage />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="p/:key/tasks" element={<ProjectTasksPage layout="list" />} />
            <Route path="p/:key/board" element={<ProjectTasksPage layout="board" />} />
            <Route path="p/:key/epics" element={<Later><EpicsPage /></Later>} />
            <Route path="p/:key/cycles" element={<Later><CyclesPage /></Later>} />
            <Route path="view/:slug" element={<ViewPage />} />
            <Route path="docs/*" element={<Later><DocsRoutes /></Later>} />
            <Route path="settings/*" element={<Later><SettingsRoutes /></Later>} />
            {insightPaths.map((path) => (
              <Route key={path} path={path} element={<Later><InsightRoutes /></Later>} />
            ))}
            <Route path="trash" element={<TrashPage />} />
            <Route path="task/:key" element={<Later><TaskPage onBack={leavePage} /></Later>} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
          </PageBoundary>
          <UploadsIndicator />
        </main>
      </div>
      <Part on={inPanel}>{inPanel && <TaskPanel taskKey={taskKey} onClose={closePanel} onExpand={phone ? undefined : expandPanel} />}</Part>
      <Part on={paletteOpen}>{paletteOpen && <CommandPalette />}</Part>
      <Part on={!!newTask}>{newTask && <CreateTaskDialog draft={newTask} />}</Part>
      <ShortcutsSheet />
      <GoHint />
    </div>
    </PeekContext>
  );
}
