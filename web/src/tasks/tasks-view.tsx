import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ChartGantt, FileWarning, ListTodo, Plus, SearchX, SquareKanban } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCollection, useLiveTasks, useMe, useOpenDecisions, useSlug } from "@/lib/selectors";
import { send } from "@/lib/mutate";
import { useRestLoaded } from "@/lib/store";
import { today } from "@/lib/time";
import { toast } from "@/lib/toast";
import { isOpenCategory, type Project, type View } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { BulkBar } from "@/tasks/bulk-bar";
import { FilterBar } from "@/tasks/filter-bar";
import { type NewTaskDraft, openNewTask } from "@/tasks/draft";
import { comparer, countFilters, emptyFilters, type Filters, fromQuery, goneFromQuery, groupTasks, matcher, normalizeQuery, sameFilters, sortFromQuery } from "@/tasks/filters";
import { TaskList } from "@/tasks/task-list";
import { filtersFromSearch, hasFilters, searchFromFilters } from "@/tasks/url-filters";
import { DisplayControls, ViewControls } from "@/tasks/view-controls";
import { defaultViewState, readDisplay, useViewState, type ViewState } from "@/tasks/view-state";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

// The board brings drag and drop with it; fetched when a board is first shown.
const Board = lazy(() => import("@/tasks/board").then((m) => ({ default: m.Board })));

interface Props {
  /** The project whose tasks are shown; for a view, the one project it is about, if it is about one. */
  project: Project | undefined;
  view?: View;
  /** Project pages take their layout from the address (/tasks or /board). */
  layout?: "list" | "board";
}

const layouts = [
  { id: "list", icon: ListTodo, label: () => t("list.layout.list") },
  { id: "board", icon: SquareKanban, label: () => t("list.layout.board") },
] as const;

/** A page of tasks: the toolbar (layout, filters, grouping, views) over a list or a board. */
export function TasksView({ project, view, layout: routeLayout }: Props) {
  const slug = useSlug();
  const me = useMe();
  const navigate = useNavigate();
  // Only the tables the page reads: a change to anything else (a comment, a notification) redraws nothing here.
  const projects = useCollection("projects");
  const statuses = useCollection("statuses");
  const members = useCollection("members");
  const labels = useCollection("labels");
  const epics = useCollection("epics");
  const cycles = useCollection("cycles");
  const all = useLiveTasks();
  const openDecisions = useOpenDecisions();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // A view written by hand or by an agent may hold a query the page cannot read; it then says so instead of failing.
  const query = useMemo(() => normalizeQuery(view?.query), [view?.query]);
  const tables = useMemo(() => ({ projects, members, statuses, labels, epics, cycles }), [projects, members, statuses, labels, epics, cycles]);

  // What the view stores that names something gone (a deleted label, a person removed). The page leaves
  // those values out and shows the rest; the note under the toolbar offers to save the view without them.
  const gone = useMemo(() => (view && query ? goneFromQuery(query, tables, me.user_id, today()) : null), [view?.id, query, tables, me.user_id]);
  const goneKey = gone ? JSON.stringify(Object.entries(gone)) : "";

  const saved: ViewState | null = useMemo(() => {
    if (!view) return defaultViewState;
    if (!query) return null;
    try {
      const display = readDisplay(view.display);
      return {
        filters: fromQuery(query, { projects, members, statuses, labels, epics, cycles }, me.user_id, today()),
        group: display.group,
        boardGroup: display.boardGroup,
        sort: display.sort ?? sortFromQuery(query) ?? "manual",
        layout: view.layout === "board" ? "board" : "list",
      };
    } catch {
      return null;
    }
    // Recomputed when the view's stored fields change (or something they name goes), not on every change to the workspace.
  }, [view?.id, query, view?.display, view?.layout, me.user_id, goneKey]);

  // The address can carry filters (a link from the dashboard, a reload): they win over what the page had.
  const location = useLocation();
  const readAddress = () => filtersFromSearch(location.search, tables, me.user_id, today(), project?.key);

  const scope = view ? `view:${view.id}` : `project:${project?.id ?? ""}`;
  const [stored, setState] = useViewState(scope, useMemo(() => ({ ...(saved ?? defaultViewState), filters: readAddress() ?? (saved ?? defaultViewState).filters }), [saved]));
  const state: ViewState = routeLayout ? { ...stored, layout: routeLayout } : stored;

  // The address changed from outside (a link, Back, a reload): take its filters.
  useLayoutEffect(() => {
    const asked = readAddress();
    if (asked && !sameFilters(asked, stored.filters)) setState({ filters: asked });
    // Only when the address changes; what the page then holds is compared as it stands.
  }, [location.search]);

  // Come back to with a bare address, the page still has its filters: say them in the address again.
  useEffect(() => {
    if (!hasFilters(location.search)) writeAddress(stored.filters);
  }, [scope]);

  function writeAddress(filters: Filters) {
    const search = searchFromFilters(filters, tables, project?.id, location.search);
    if (search !== location.search) navigate({ pathname: location.pathname, search }, { replace: true, state: location.state });
  }

  /** A filter changed here: the page takes it at once, and the address follows. */
  function setFilters(filters: Filters) {
    setState({ filters });
    writeAddress(filters);
  }
  usePageTitle(view ? view.name : (project?.name ?? ""));

  const projectIds = useMemo(() => {
    if (project) return [project.id];
    const keys = (query?.project ?? []).map((k) => k.toLowerCase());
    return Object.values(projects)
      .filter((p) => keys.includes(p.key.toLowerCase()) || keys.includes(p.id))
      .map((p) => p.id);
  }, [project, query, projects]);

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

  const changed =
    !!view &&
    !!saved &&
    (!sameFilters(state.filters, saved.filters) ||
      state.group !== saved.group ||
      state.boardGroup !== saved.boardGroup ||
      state.sort !== saved.sort ||
      state.layout !== saved.layout);
  const filtered = countFilters(state.filters) > 0 || state.filters.text !== "";
  const chosen = useMemo(() => tasks.filter((task) => selected.has(task.id)), [tasks, selected]);
  const add = useCallback(
    (draft: NewTaskDraft = {}) => openNewTask({ projectId: project?.id ?? projectIds[0], ...draft }),
    [project?.id, projectIds],
  );
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  if (view && !saved) return <UnreadableView view={view} scope={scope} project={project} />;

  /** Saves the view without the values that name something gone. */
  function fixView() {
    if (!view || !gone) return;
    const fixed = { ...view.query, ...gone };
    send({ type: "view.update", args: { id: view.id, query: fixed } }, (tx) => tx.patch("views", view.id, { query: fixed }));
    toast.info(t("view.updated"));
  }

  function setLayout(next: "list" | "board") {
    if (routeLayout && project) navigate(`/${slug}/p/${project.key}/${next === "board" ? "board" : "tasks"}${location.search}`);
    else setState({ layout: next });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-2 no-scrollbar md:px-3">
        <div role="tablist" aria-label={t("list.layout")} className="flex shrink-0 items-center rounded-md bg-sunken p-0.5">
          {layouts.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={state.layout === id}
              onClick={() => setLayout(id)}
              className={cx(
                "flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-medium",
                state.layout === id ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              <span className="max-sm:hidden">{label()}</span>
            </button>
          ))}
          {/* A project's third layout is a page of its own (insights/timeline). */}
          {routeLayout && project && (
            <button
              type="button"
              role="tab"
              aria-selected={false}
              onClick={() => navigate(`/${slug}/p/${project.key}/timeline`)}
              className="flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-ink-2 hover:text-ink"
            >
              <ChartGantt className="size-3.5" aria-hidden />
              <span className="max-sm:hidden">{t("nav.timeline")}</span>
            </button>
          )}
        </div>
        <FilterBar filters={state.filters} onChange={setFilters} project={project} />
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <DisplayControls state={state} onChange={setState} />
          <ViewControls state={state} scope={scope} project={project} view={view} changed={changed} />
        </div>
      </div>

      {gone && (
        <p role="status" className="flex min-h-8 shrink-0 items-center gap-2 border-b border-line bg-sunken px-3 text-xs text-ink-2 md:px-4">
          {t("view.gone")}
          <Button size="sm" onClick={fixView}>
            {t("view.fix")}
          </Button>
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {tasks.length === 0 && !board && restLoaded ? (
          filtered ? (
            <EmptyState
              icon={<SearchX />}
              title={t("list.emptyFiltered")}
              hint={t("list.emptyFilteredHint")}
              action={<Button onClick={() => setFilters(emptyFilters)}>{t("list.clearFilters")}</Button>}
            />
          ) : (
            <EmptyState
              icon={<ListTodo />}
              title={t("list.empty")}
              hint={t("list.emptyHint")}
              action={
                <Button variant="primary" onClick={() => add()}>
                  <Plus className="size-4" aria-hidden />
                  {t("top.newTask")}
                </Button>
              }
            />
          )
        ) : board ? (
          <Suspense fallback={<Loading />}>
            <Board groups={groups} project={project} />
          </Suspense>
        ) : (
          <TaskList groups={groups} selected={selected} onSelectedChange={setSelected} onAdd={add} />
        )}
        {!board && <BulkBar tasks={chosen} onClear={clearSelection} />}
      </div>
    </div>
  );
}

/**
 * What a saved view shows when its stored filter is not something the page
 * can read. The view can still be renamed or deleted from its menu.
 */
function UnreadableView({ view, scope, project }: { view: View; scope: string; project: Project | undefined }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-end gap-1 border-b border-line px-2 md:px-3">
        <ViewControls state={defaultViewState} scope={scope} project={project} view={view} changed={false} />
      </div>
      <div className="min-h-0 flex-1">
        <EmptyState icon={<FileWarning />} title={t("view.unreadable")} hint={t("view.unreadableHint")} />
      </div>
    </div>
  );
}
