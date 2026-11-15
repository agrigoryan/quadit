// A page of tasks: the toolbar (layout, filters, grouping, views) over a
// list or a board. What it starts from is tasks/saved-view.ts, and how its
// filters follow the address tasks/page-state.ts.

import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { FileWarning, ListTodo, Plus, SearchX } from "lucide-react";
import { t } from "@/lib/i18n";
import { send } from "@/lib/mutate";
import { useCan } from "@/lib/access";
import { useLiveTasks, useLookup, useLookupEvenIfGone, useMe, useOpenDecisions } from "@/lib/selectors";
import { useRestLoaded } from "@/lib/store";
import { toast } from "@/lib/toast";
import { isOpenCategory, type Project, type View } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { BulkBar } from "@/tasks/bulk-bar";
import { type NewTaskDraft, openNewTask } from "@/tasks/draft";
import { FilterBar } from "@/tasks/filter-bar";
import { comparer, countFilters, emptyFilters, type Filters, groupTasks, matcher, sameFilters } from "@/tasks/filters";
import { LayoutTabs } from "@/tasks/layout-tabs";
import { usePageState } from "@/tasks/page-state";
import { useSavedView } from "@/tasks/saved-view";
import { TaskList } from "@/tasks/task-list";
import { DisplayControls, ViewControls } from "@/tasks/view-controls";
import { defaultViewState } from "@/tasks/view-state";
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

export function TasksView({ project, view, layout: routeLayout }: Props) {
  const me = useMe();
  const can = useCan();
  // Only the tables the page reads: a change to anything else (a comment, a notification) redraws nothing here.
  // A view of an archived project is still about that project.
  const projects = useLookupEvenIfGone("projects");
  const statuses = useLookup("statuses");
  const members = useLookup("members");
  const labels = useLookup("labels");
  const epics = useLookup("epics");
  const cycles = useLookup("cycles");
  // Grouping still names a removed assignee or a deleted epic that tasks are in (tasks/filters.ts, GroupSource).
  const everyMember = useLookupEvenIfGone("members");
  const everyEpic = useLookupEvenIfGone("epics");
  const tables = useMemo(
    () => ({ projects, members, statuses, labels, epics, cycles }),
    [projects, members, statuses, labels, epics, cycles],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const { query, gone, saved } = useSavedView(view, tables, me.user_id);
  const scope = view ? `view:${view.id}` : `project:${project?.id ?? ""}`;
  const { state, setState, setFilters } = usePageState({
    scope,
    saved,
    tables,
    meId: me.user_id,
    project,
    routeLayout,
  });
  usePageTitle(view ? view.name : (project?.name ?? ""));
  const all = useLiveTasks();
  const openDecisions = useOpenDecisions();

  // The projects a page is about: its own, or those its view's query names (none: every project).
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
    const source = { statuses, members: everyMember, epics: everyEpic, labels };
    const made = groupTasks(tasks, by, source, project?.id, board || !restLoaded);
    if (board || restLoaded) return made;
    return made.filter((g) => g.tasks.length > 0 || (g.kind === "status" && !isOpenCategory(g.category)));
  }, [tasks, state.group, state.boardGroup, board, restLoaded, statuses, everyMember, everyEpic, labels, project?.id]);

  const changed =
    !!view &&
    !!saved &&
    (!sameFilters(state.filters, saved.filters) ||
      state.group !== saved.group ||
      state.boardGroup !== saved.boardGroup ||
      state.sort !== saved.sort ||
      state.subtasks !== saved.subtasks ||
      state.layout !== saved.layout);
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
    send({ type: "view.update", args: { id: view.id, query: fixed } }, (tx) =>
      tx.patch("views", view.id, { query: fixed }),
    );
    toast.info(t("view.updated"));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-2 no-scrollbar md:px-3">
        <LayoutTabs
          layout={state.layout}
          routeProject={routeLayout ? project : undefined}
          onChange={(layout) => setState({ layout })}
        />
        <FilterBar filters={state.filters} onChange={setFilters} project={project} />
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <DisplayControls state={state} onChange={setState} />
          <ViewControls state={state} scope={scope} project={project} view={view} changed={changed} />
        </div>
      </div>

      {gone && (
        <p
          role="status"
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-line bg-sunken px-3 text-xs text-ink-2 md:px-4"
        >
          {t("view.gone")}
          {view && can.editMadeBy(view.owner_id) && (
            <Button size="sm" onClick={fixView}>
              {t("view.fix")}
            </Button>
          )}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {tasks.length === 0 && !board && restLoaded ? (
          <NoTasks
            filters={state.filters}
            onClearFilters={() => setFilters(emptyFilters)}
            onAdd={can.edit(project?.id) ? () => add() : undefined}
          />
        ) : board ? (
          <Suspense fallback={<Loading />}>
            <Board groups={groups} project={project} />
          </Suspense>
        ) : (
          <TaskList
            groups={groups}
            nested={state.subtasks === "nested"}
            sort={state.sort}
            selected={selected}
            onSelectedChange={setSelected}
            onAdd={can.edit(project?.id) ? add : undefined}
          />
        )}
        {!board && <BulkBar tasks={chosen} onClear={clearSelection} />}
      </div>
    </div>
  );
}

/** What an empty list says: nothing passes the filters, or there is nothing yet. */
function NoTasks({
  filters,
  onClearFilters,
  onAdd,
}: {
  filters: Filters;
  onClearFilters: () => void;
  /** Left out for someone who may not create tasks here. */
  onAdd?: () => void;
}) {
  if (countFilters(filters) > 0 || filters.text !== "") {
    return (
      <EmptyState
        icon={<SearchX />}
        title={t("list.emptyFiltered")}
        hint={t("list.emptyFilteredHint")}
        action={<Button onClick={onClearFilters}>{t("list.clearFilters")}</Button>}
      />
    );
  }
  return (
    <EmptyState
      icon={<ListTodo />}
      title={t("list.empty")}
      hint={t("list.emptyHint")}
      action={
        onAdd && (
          <Button variant="primary" onClick={onAdd}>
            <Plus className="size-4" aria-hidden />
            {t("top.newTask")}
          </Button>
        )
      }
    />
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
