import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useCan } from "@/lib/access";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate } from "@/lib/mutate";
import { sortByRank, useArchived, useLookupEvenIfGone, useProjects } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import type { Project } from "@/lib/types";
import { useSettingsBase } from "@/settings/base";
import { useTasksOutOfTrash } from "@/settings/projects/data";
import { KEY_RE, PROJECT_FIELDS, type ProjectDraft, ProjectFields } from "@/settings/projects/project-form";
import { SWATCHES } from "@/lib/swatches";
import { refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { Page, Rows, Section } from "@/ui/page-layout";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

function ProjectRow({ project, tasks }: { project: Project; tasks: number }) {
  const base = useSettingsBase();
  return (
    <Link
      to={`${base}/projects/${project.key}`}
      aria-label={t("projects.open", { name: project.name })}
      className="flex min-h-11 items-center gap-3 px-3 py-1.5 hover:bg-hover/60"
    >
      <ProjectGlyph project={project} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {project.icon ? `${project.icon} ` : ""}
            {project.name}
          </span>
          {project.archived_at && <Badge>{t("projects.archivedBadge")}</Badge>}
        </span>
        {project.description && <span className="block truncate text-xs text-ink-3">{project.description}</span>}
      </span>
      <span className="shrink-0 font-mono text-xs text-ink-3">{project.key}</span>
      <span className="w-16 shrink-0 text-right text-xs text-ink-2 tnum max-sm:hidden">
        {t("projects.tasks", { n: tasks })}
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />
    </Link>
  );
}

/** Every project of the workspace, and the way to make one. */
export function ProjectsPage() {
  const base = useSettingsBase();
  const admin = useCan().administer;
  const active = useProjects();
  const archivedRows = useArchived("projects");
  // Trashed ones too: the colour of a new project follows how many were ever made.
  const everyProject = useLookupEvenIfGone("projects");
  const tasks = useTasksOutOfTrash();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);

  // The first-run call on My work links here with ?new=1.
  useEffect(() => {
    if (params.get("new") && admin) {
      // oxlint-disable-next-line react/set-state-in-effect -- the link is used up as it is followed, opening the dialog and leaving the address; taken off on close instead, it would undo the move to a project just made
      setCreating(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams, admin]);

  const archived = useMemo(() => sortByRank(archivedRows), [archivedRows]);
  const counts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of tasks) counts[task.project_id] = (counts[task.project_id] ?? 0) + 1;
    return counts;
  }, [tasks]);

  const newButton = admin && (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Plus className="size-3.5" aria-hidden />
      {t("projects.new")}
    </Button>
  );

  return (
    <Page title={t("projects.title")} lead={t("projects.lead")} back={base} actions={active.length > 0 && newButton}>
      {active.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong">
          <EmptyState
            title={t("projects.none")}
            hint={admin ? t("projects.noneHint") : t("projects.noneMember")}
            action={newButton}
          />
        </div>
      ) : (
        <Rows>
          {active.map((p) => (
            <ProjectRow key={p.id} project={p} tasks={counts[p.id] ?? 0} />
          ))}
        </Rows>
      )}
      {archived.length > 0 && (
        <Section title={t("projects.archived")}>
          <Rows>
            {archived.map((p) => (
              <ProjectRow key={p.id} project={p} tasks={counts[p.id] ?? 0} />
            ))}
          </Rows>
        </Section>
      )}
      {creating && <CreateProjectDialog used={Object.keys(everyProject).length} onClose={() => setCreating(false)} />}
    </Page>
  );
}

function CreateProjectDialog({ used, onClose }: { used: number; onClose: () => void }) {
  const base = useSettingsBase();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ProjectDraft>({
    key: "",
    name: "",
    icon: "",
    color: SWATCHES[(used + 1) % SWATCHES.length] ?? "",
    description: "",
  });
  const errors = useFieldErrors(PROJECT_FIELDS);
  const set = (patch: Partial<ProjectDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit() {
    if (!draft.name.trim()) refuse("name", t("s.required"));
    if (!KEY_RE.test(draft.key)) refuse("key", t("project.keyBad"));
    await mutate(
      {
        type: "project.create",
        args: {
          id: newId(),
          key: draft.key,
          name: draft.name.trim(),
          icon: draft.icon.trim(),
          color: draft.color,
          description: draft.description.trim(),
        },
      },
      undefined,
      { quiet: true },
    );
    toast.info(t("project.created", { name: draft.name.trim() }));
    void navigate(`${base}/projects/${draft.key}/statuses`);
  }

  return (
    <FormDialog
      title={t("projects.new")}
      submit={t("project.create")}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <ProjectFields draft={draft} set={set} errors={errors} />
    </FormDialog>
  );
}
