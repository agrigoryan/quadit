import { useParams } from "react-router";
import { useProjectByKey, useViews } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { NotFoundPage } from "@/shell/placeholders";
import { normalizeQuery } from "@/tasks/filters";
import { TasksView } from "@/tasks/tasks-view";

/** /:ws/p/:key/tasks and /:ws/p/:key/board */
export function ProjectTasksPage({ layout }: { layout: "list" | "board" }) {
  const { key } = useParams();
  const project = useProjectByKey(key);
  if (!project) return <NotFoundPage />;
  return <TasksView key={project.id} project={project} layout={layout} />;
}

/** /:ws/view/:slug — a saved view: its filters, grouping and layout restored. */
export function ViewPage() {
  const { slug } = useParams();
  const view = useViews().find((v) => v.slug === slug);
  const projects = useStore((s) => s.c.projects);
  if (!view) return <NotFoundPage />;
  // The query may be anything a person or an agent stored; read it carefully.
  const keys = normalizeQuery(view.query)?.project ?? [];
  const only = keys.length === 1 ? keys[0] : undefined;
  const project =
    (view.project_id ? projects[view.project_id] : undefined) ??
    (only ? Object.values(projects).find((p) => p.id === only || p.key.toLowerCase() === only.toLowerCase()) : undefined);
  return <TasksView key={view.id} project={project} view={view} />;
}
