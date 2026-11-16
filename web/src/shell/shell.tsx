import { lazy, type ReactElement, type ReactNode, Suspense, useCallback, useEffect, useMemo } from "react";
import { type Location, matchPath, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { useOnePane } from "@/hooks/breakpoints";
import { ShortcutsSheet } from "@/palette/shortcuts";
import { ahead } from "@/shell/ahead";
import { useCan } from "@/data/access";
import { useHotkeys } from "@/hooks/hotkeys";
import { useStore } from "@/data/store";
import { ui, useUi } from "@/lib/ui-state";
import { InboxPage } from "@/pages/inbox";
import { MyWorkPage } from "@/pages/my-work";
import { TrashPage } from "@/pages/trash";
import { insightPaths } from "@/insights/paths";
import { PageBoundary, PartBoundary } from "@/shell/error-boundary";
import { GoHint, useGoKeys } from "@/shell/go-keys";
import { usePageFocus } from "@/shell/page-focus";
import { NotFoundPage } from "@/ui/not-found";
import { pageUnder, projectInView } from "@/nav/project-in-view";
import { Loading } from "@/ui/spinner";
import { Sidebar } from "@/shell/sidebar";
import { TopBar } from "@/shell/topbar";
import { UndoKeys } from "@/shell/undo-keys";
import { UploadsIndicator } from "@/shell/uploads";
import { canGoBack, isTaskPath, type Peek, PeekContext, taskPath } from "@/nav/task-link";
import { leaveForPage } from "@/nav/task-queue";
import type { Member } from "@/types/core";
import { MemberCard } from "@/tasks/member-card";
import { ProjectTasksPage, ViewPage } from "@/tasks/tasks-page";
import { MemberMention } from "@/ui/member-mention";

// The larger parts of the app are fetched when first opened.
/** A member's mention in Markdown opens the card about them. */
const memberCard = (member: Member, control: ReactElement) => <MemberCard member={member}>{control}</MemberCard>;

const DocsRoutes = lazy(() => import("@/docs/routes"));
const SettingsRoutes = lazy(() => import("@/settings/routes"));
const InsightRoutes = lazy(() => import("@/insights/routes"));
const EpicsPage = lazy(() => import("@/insights/plan/epics-page").then((m) => ({ default: m.EpicsPage })));
const CyclesPage = lazy(() => import("@/insights/plan/cycles-page").then((m) => ({ default: m.CyclesPage })));

// So are the parts drawn over the page, and a task's own page. These are
// also fetched ahead, once the first page is up, so that opening a task,
// the palette or the new-task dialog does not wait on the network; and once
// their code is here they are drawn without a round through Suspense
// (shell/ahead.tsx).
const taskPanel = ahead(() => import("@/detail/task-panel").then((m) => m.TaskPanel));
const taskPage = ahead(() => import("@/detail/task-page").then((m) => m.TaskPage));
const palette = ahead(() => import("@/palette/palette").then((m) => m.CommandPalette));
const createTask = ahead(() => import("@/tasks/create-task").then((m) => m.CreateTaskDialog));

function fetchAhead() {
  for (const part of [taskPanel, taskPage, palette, createTask]) part.fetch().catch(() => {});
}

// The address is a task's (a link opened in a new tab): its page is asked for now, along with the workspace.
if (typeof window !== "undefined" && isTaskPath(window.location.pathname)) taskPage.fetch().catch(() => {});

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
 * A task's address is /:ws/task/:key (nav/task-link.ts). Opened from a
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
  const phone = useOnePane();
  const inPanel = !!taskKey && (!!background || phone);
  const projectKey = taskKey?.split("-")[0];
  const fallback = `/${slug}/${projectKey ? `p/${projectKey}/tasks` : "my-work"}`;
  const page: Location | string = inPanel ? (background ?? fallback) : location;
  const pagePath = typeof page === "string" ? page : page.pathname;

  // A new task goes in the project in view: offered only to someone who may make one there.
  const projectId = projectInView(location)?.id;
  const mayCreate = useCan().edit(projectId);
  const openNewTask = () => {
    if (mayCreate) ui.newTask({ projectId });
  };
  // The panel is one step above its page in the history: closing it is going back that step.
  const closePanel = useCallback(
    () => void (background && canGoBack() ? navigate(-1) : navigate(fallback)),
    [background, fallback, navigate],
  );
  // The page's place is taken by the panel's, so one step back from the page is the list again.
  const expandPanel = () => {
    const from = leaveForPage();
    if (taskKey) void navigate(taskPath(slug, taskKey), { replace: !!background, state: from ? { from } : undefined });
  };
  // From a task's page: back to where the person was, or to the task's list when they arrived by its address.
  const leavePage = () => void (canGoBack() ? navigate(-1) : navigate(fallback));
  const peek = useMemo<Peek>(
    () => ({ key: inPanel ? taskKey : undefined, close: closePanel }),
    [inPanel, taskKey, closePanel],
  );

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
      // The browser's own Back and Forward, under the keys other apps of this kind give them (a Mac browser has them already).
      "mod+[": (e) => {
        e.preventDefault();
        void navigate(-1);
      },
      "mod+]": (e) => {
        e.preventDefault();
        void navigate(1);
      },
    },
    { layer: "global" },
  );
  useGoKeys();
  usePageFocus(location.key);

  return (
    <PeekContext value={peek}>
      <MemberMention value={memberCard}>
        <div className="flex h-dvh overflow-hidden">
          <UndoKeys />
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar onNewTask={mayCreate ? openNewTask : undefined} />
            {/* It takes the focus after each move (shell/page-focus.ts); what looks focused is then the page's own current row. */}
            <main data-page tabIndex={-1} className="relative min-h-0 flex-1 overflow-hidden bg-surface outline-none">
              <PageBoundary resetKey={pagePath}>
                <Routes location={page}>
                  <Route index element={<Navigate to="my-work" replace />} />
                  <Route path="my-work" element={<MyWorkPage />} />
                  <Route path="inbox" element={<InboxPage />} />
                  <Route path="p/:key/tasks" element={<ProjectTasksPage layout="list" />} />
                  <Route path="p/:key/board" element={<ProjectTasksPage layout="board" />} />
                  <Route
                    path="p/:key/epics"
                    element={
                      <Later>
                        <EpicsPage />
                      </Later>
                    }
                  />
                  <Route
                    path="p/:key/cycles"
                    element={
                      <Later>
                        <CyclesPage />
                      </Later>
                    }
                  />
                  <Route path="view/:slug" element={<ViewPage />} />
                  <Route
                    path="p/:key/docs/*"
                    element={
                      <Later>
                        <DocsRoutes />
                      </Later>
                    }
                  />
                  <Route
                    path="docs/*"
                    element={
                      <Later>
                        <DocsRoutes />
                      </Later>
                    }
                  />
                  <Route
                    path="settings/*"
                    element={
                      <Later>
                        <SettingsRoutes />
                      </Later>
                    }
                  />
                  {insightPaths.map((path) => (
                    <Route
                      key={path}
                      path={path}
                      element={
                        <Later>
                          <InsightRoutes />
                        </Later>
                      }
                    />
                  ))}
                  <Route path="trash" element={<TrashPage />} />
                  <Route
                    path="task/:key"
                    element={
                      <Later>
                        <taskPage.Part onBack={leavePage} />
                      </Later>
                    }
                  />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </PageBoundary>
              <UploadsIndicator />
            </main>
          </div>
          <Part on={inPanel}>
            {inPanel && (
              <taskPanel.Part taskKey={taskKey} onClose={closePanel} onExpand={phone ? undefined : expandPanel} />
            )}
          </Part>
          <Part on={paletteOpen}>{paletteOpen && <palette.Part />}</Part>
          <Part on={!!newTask}>{newTask && <createTask.Part draft={newTask} />}</Part>
          <ShortcutsSheet />
          <GoHint />
        </div>
      </MemberMention>
    </PeekContext>
  );
}
