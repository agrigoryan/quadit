import { Link, Navigate, NavLink, Route, Routes, useParams } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import { useIsAdmin, useSettingsBase } from "@/settings/base";
import { ProjectGeneral } from "@/settings/projects/general";
import { ProjectLabels } from "@/settings/projects/labels";
import { ProjectPreferences } from "@/settings/projects/preferences";
import { ProjectStatuses } from "@/settings/projects/statuses";
import { ProjectTemplates } from "@/settings/projects/templates";
import { Page } from "@/ui/settings-layout";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Badge } from "@/ui/badge";
import { EmptyState } from "@/ui/empty";

const TABS = ["general", "statuses", "labels", "templates", "preferences"] as const;

/** One project's settings, a tab for each part. */
export function ProjectPage() {
  const { key = "" } = useParams();
  const base = useSettingsBase();
  const admin = useIsAdmin();
  const projects = useCollection("projects");
  const project = Object.values(projects).find((p) => p.key.toLowerCase() === key.toLowerCase() && !p.deleted_at);

  if (!project) {
    return (
      <EmptyState
        title={t("project.notFound")}
        action={
          <Link to={`${base}/projects`} className="text-sm font-medium text-accent-text hover:underline">
            {t("project.back")}
          </Link>
        }
      />
    );
  }

  const root = `${base}/projects/${project.key}`;
  return (
    <Page
      title={`${project.icon ? `${project.icon} ` : ""}${project.name}`}
      back={`${base}/projects`}
      backLabel={t("project.back")}
      lead={
        <span className="flex items-center gap-2">
          <ProjectGlyph project={project} />
          <span className="font-mono text-xs">{project.key}</span>
          {project.archived_at && <Badge>{t("projects.archivedBadge")}</Badge>}
          {!admin && <span className="text-ink-3">· {t("s.adminOnly")}</span>}
        </span>
      }
    >
      <div className="-mt-2 flex flex-col gap-6">
        <nav className="no-scrollbar -mx-4 flex gap-0.5 overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0">
          {TABS.map((tab) => (
            <NavLink
              key={tab}
              to={`${root}/${tab}`}
              replace
              className={({ isActive }) =>
                cx(
                  "-mb-px flex h-8 shrink-0 items-center border-b-2 px-2.5 text-sm font-medium transition-colors",
                  isActive ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink",
                )
              }
            >
              {t(`project.tab.${tab}`)}
            </NavLink>
          ))}
        </nav>
        <Routes>
          <Route index element={<Navigate to="general" replace />} />
          <Route path="general" element={<ProjectGeneral key={project.id} project={project} admin={admin} />} />
          <Route path="statuses" element={<ProjectStatuses project={project} admin={admin} />} />
          <Route path="labels" element={<ProjectLabels project={project} />} />
          <Route path="templates" element={<ProjectTemplates project={project} />} />
          <Route path="preferences" element={<ProjectPreferences project={project} admin={admin} />} />
          <Route path="*" element={<Navigate to={`${root}/general`} replace />} />
        </Routes>
      </div>
    </Page>
  );
}
