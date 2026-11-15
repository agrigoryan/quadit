// What a project's Docs show when no page is open: what they are for and
// the ways to start one.

import { FilePlus2, FileText } from "lucide-react";
import { useCan } from "@/data/access";
import { t } from "@/lib/i18n";
import type { Project } from "@/types/core";
import { usePageTitle } from "@/lib/ui-state";
import { MovePagesHere } from "@/docs/project-move";
import { createAndOpen } from "@/docs/tree/new-page";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

interface Props {
  project: Project;
  /** The project has no page yet: this is all there is to show. */
  empty?: boolean;
}

export function ProjectDocsHome({ project, empty }: Props) {
  const name = { project: project.name };
  usePageTitle(t("docs.projectHome.title", name));
  const can = useCan();
  return (
    <EmptyState
      icon={<FileText />}
      title={t(empty ? "docs.projectEmpty.title" : "docs.projectHome.title", name)}
      hint={t(empty ? "docs.projectEmpty.hint" : "docs.projectHome.hint", name)}
      action={
        can.edit(project.id) && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={() => createAndOpen({ projectId: project.id })}>
              <FilePlus2 className="size-4" aria-hidden />
              {t("docs.new.page")}
            </Button>
            <MovePagesHere project={project} />
          </div>
        )
      }
    />
  );
}
