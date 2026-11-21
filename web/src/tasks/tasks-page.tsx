import { useParams } from "react-router";
import { useLookupEvenIfGone, useProjectByKey, useViews } from "@/data/selectors";
import { NotFoundPage } from "@/ui/not-found";
import { normalizeQuery } from "@/tasks/filters";
import { SamplesNote } from "@/tasks/samples-note";
import { TasksView } from "@/tasks/tasks-view";

/** /:ws/p/:key/tasks and /:ws/p/:key/board; the project the sample tasks are in says so above them. */
export function ProjectTasksPage({ layout }: { layout: "list" | "board" }) {
  const { key } = useParams();
  const project = useProjectByKey(key);
  if (!project) return <NotFoundPage />;
  return (
    <div className="flex h-full flex-col">
      <SamplesNote project={project} />
      <div className="min-h-0 flex-1">
        <TasksView key={project.id} project={project} layout={layout} />
      </div>
    </div>
  );
}

/** /:ws/view/:slug — a saved view: its filters, grouping and layout restored. */
export function ViewPage() {
  const { slug } = useParams();
  const view = useViews().find((v) => v.slug === slug);
  // A view of an archived project is still about that project.
  const projects = useLookupEvenIfGone("projects");
  if (!view) return <NotFoundPage />;
  // The query may be anything a person or an agent stored; read it carefully.
  const keys = normalizeQuery(view.query)?.project ?? [];
  const only = keys.length === 1 ? keys[0] : undefined;
  const project =
    (view.project_id ? projects[view.project_id] : undefined) ??
    (only
      ? Object.values(projects).find((p) => p.id === only || p.key.toLowerCase() === only.toLowerCase())
      : undefined);
  return <TasksView key={view.id} project={project} view={view} />;
}
