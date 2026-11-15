// The project a page is tied to, drawn as the project's own mark. The tree
// shows it where a page's project is not its parent's, so a project's
// pages read as one branch and a page tied elsewhere stands out.

import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Tooltip } from "@/ui/tooltip";

/** A dashed square: no project, where one would be expected. */
export function NoProjectGlyph({ className }: { className?: string }) {
  return <span className={cx("size-4 shrink-0 rounded-xs border border-dashed border-ink-3", className)} aria-hidden />;
}

interface Props {
  /** The page's project; none draws the dashed square. */
  projectId: string | undefined;
  className?: string;
}

/** A project's mark with its name on hover. Nothing for a project the person cannot see. */
export function ProjectMark({ projectId, className }: Props) {
  const project = useStore((s) => (projectId ? s.collections.projects[projectId] : undefined));
  if (projectId && !project) return null;
  const label = project ? t("docs.project.in", { project: project.name }) : t("docs.project.notInParents");
  return (
    <Tooltip label={label}>
      <span role="img" aria-label={label} className={cx("flex shrink-0 items-center", className)}>
        {project ? <ProjectGlyph project={project} /> : <NoProjectGlyph />}
      </span>
    </Tooltip>
  );
}

/** Whether a page shows its project in a tree: only where it differs from the page it hangs under. */
export const marksProject = (doc: { project_id?: string }, parentProject: string | undefined) =>
  (doc.project_id ?? "") !== (parentProject ?? "");
