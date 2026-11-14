import { lazy, Suspense, useMemo, useState } from "react";
import { ChartGantt, ListTodo, Plus, SearchX, SquareKanban } from "lucide-react";
import { useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useLiveTasks, useMe, useOpenDecisions, useSlug } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { today } from "@/lib/time";
import type { Project, View } from "@/lib/types";
import { type TaskDraft, ui, usePageTitle } from "@/lib/ui-state";
import { BulkBar } from "@/tasks/bulk-bar";
import { FilterBar } from "@/tasks/filter-bar";
import { comparer, countFilters, emptyFilters, fromQuery, groupTasks, matcher, sameFilters, sortFromQuery } from "@/tasks/filters";
import { TaskList } from "@/tasks/task-list";
import { DisplayControls, ViewControls } from "@/tasks/view-controls";
import { defaultViewState, useViewState, type ViewState } from "@/tasks/view-state";
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
  const c = useStore((s) => s.c);
  const all = useLiveTasks();
  const openDecisions = useOpenDecisions();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const saved: ViewState = useMemo(() => {
    if (!view) return defaultViewState;
    return {
      filters: fromQuery(view.query, c, me.user_id, today()),
      group: view.display?.group ?? "status",
      sort: view.display?.sort ?? sortFromQuery(view.query) ?? "manual",
      layout: view.layout === "board" ? "board" : "list",
    };
    // Recomputed when the view's stored fields change, not on every change to the workspace.
  }, [view?.id, view?.query, view?.display, view?.layout, me.user_id]);

  const scope = view ? `view:${view.id}` : `project:${project?.id ?? ""}`;
  const [stored, setState] = useViewState(scope, saved);
  const state: ViewState = routeLayout ? { ...stored, layout: routeLayout } : stored;
  usePageTitle(view ? view.name : (project?.name ?? ""));

  const projectIds = useMemo(() => {
    if (project) return [project.id];
    const keys = (view?.query?.project ?? []).map((k) => k.toLowerCase());
    return Object.values(c.projects)
      .filter((p) => keys.includes(p.key.toLowerCase()) || keys.includes(p.id))
      .map((p) => p.id);
  }, [project, view?.query?.project, c.projects]);

  const tasks = useMemo(() => {
    const match = matcher(state.filters, c, openDecisions);
    const inScope = all.filter((task) => (projectIds.length === 0 || projectIds.includes(task.project_id)) && match(task));
    return inScope.sort(comparer(state.layout === "board" ? "manual" : state.sort));
  }, [all, state.filters, state.sort, state.layout, c, openDecisions, projectIds]);

  // The board keeps every column; the list leaves out sections with nothing in them.
  const groups = useMemo(() => {
    const board = state.layout === "board";
    const made = groupTasks(tasks, board ? "status" : state.group, c, project?.id);
    return board ? made : made.filter((g) => g.tasks.length > 0);
  }, [tasks, state.group, state.layout, c, project?.id]);

  const changed =
    !!view && (!sameFilters(state.filters, saved.filters) || state.group !== saved.group || state.sort !== saved.sort || state.layout !== saved.layout);
  const filtered = countFilters(state.filters) > 0 || state.filters.text !== "";
  const chosen = useMemo(() => tasks.filter((task) => selected.has(task.id)), [tasks, selected]);
  const add = (draft: TaskDraft = {}) => ui.newTask({ projectId: project?.id ?? projectIds[0], ...draft });

  function setLayout(next: "list" | "board") {
    if (routeLayout && project) navigate(`/${slug}/p/${project.key}/${next === "board" ? "board" : "tasks"}`);
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
        <FilterBar filters={state.filters} onChange={(filters) => setState({ filters })} project={project} />
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <DisplayControls state={state} onChange={setState} />
          <ViewControls state={state} scope={scope} project={project} view={view} changed={changed} />
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {tasks.length === 0 && state.layout === "list" ? (
          filtered ? (
            <EmptyState
              icon={<SearchX />}
              title={t("list.emptyFiltered")}
              hint={t("list.emptyFilteredHint")}
              action={<Button onClick={() => setState({ filters: emptyFilters })}>{t("list.clearFilters")}</Button>}
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
        ) : state.layout === "board" ? (
          <Suspense fallback={<Loading />}>
            <Board groups={groups} projectId={project?.id} />
          </Suspense>
        ) : (
          <div className="h-full overflow-y-auto">
            <TaskList groups={groups} selected={selected} onSelectedChange={setSelected} onAdd={add} />
          </div>
        )}
        <BulkBar tasks={chosen} onClear={() => setSelected(new Set())} />
      </div>
    </div>
  );
}
