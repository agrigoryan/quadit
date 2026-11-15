import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate } from "@/lib/mutate";
import { useCollection } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import type { Project } from "@/lib/types";
import { useIsAdmin, useSettingsBase } from "@/settings/base";
import { KEY_RE, PROJECT_FIELDS, type ProjectDraft, ProjectFields } from "@/settings/projects/project-form";
import { SWATCHES } from "@/settings/ui/bits";
import { FormAlert, useFieldErrors, useSubmit } from "@/settings/ui/form";
import { Page, Rows, Section } from "@/settings/ui/layout";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { EmptyState } from "@/ui/empty";

const byRank = (a: Project, b: Project) => ((a.rank ?? "") < (b.rank ?? "") ? -1 : 1);

function ProjectRow({ project, tasks }: { project: Project; tasks: number }) {
  const base = useSettingsBase();
  return (
    <Link to={`${base}/projects/${project.key}`} aria-label={t("projects.open", { name: project.name })} className="flex min-h-11 items-center gap-3 px-3 py-1.5 hover:bg-hover/60">
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
      <span className="w-16 shrink-0 text-right text-xs text-ink-2 tnum max-sm:hidden">{t("projects.tasks", { n: tasks })}</span>
      <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />
    </Link>
  );
}

/** Every project of the workspace, and the way to make one. */
export function ProjectsPage() {
  const base = useSettingsBase();
  const admin = useIsAdmin();
  const projects = useCollection("projects");
  const tasks = useCollection("tasks");
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);

  // The first-run call on My work links here with ?new=1.
  useEffect(() => {
    if (params.get("new") && admin) {
      setCreating(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams, admin]);

  const { active, archived, counts } = useMemo(() => {
    const live = Object.values(projects).filter((p) => !p.deleted_at).sort(byRank);
    const counts: Record<string, number> = {};
    for (const task of Object.values(tasks)) if (!task.deleted_at) counts[task.project_id] = (counts[task.project_id] ?? 0) + 1;
    return { active: live.filter((p) => !p.archived_at), archived: live.filter((p) => p.archived_at), counts };
  }, [projects, tasks]);

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
          <EmptyState title={t("projects.none")} hint={admin ? t("projects.noneHint") : t("projects.noneMember")} action={newButton} />
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
      {creating && <CreateProjectDialog used={Object.values(projects).length} onClose={() => setCreating(false)} />}
    </Page>
  );
}

function CreateProjectDialog({ used, onClose }: { used: number; onClose: () => void }) {
  const base = useSettingsBase();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ProjectDraft>({ key: "", name: "", icon: "", color: SWATCHES[(used + 1) % SWATCHES.length] ?? "", description: "" });
  const errors = useFieldErrors(PROJECT_FIELDS);
  const { busy, run } = useSubmit(errors, { once: true });
  const set = (patch: Partial<ProjectDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!draft.name.trim()) return errors.set("name", t("s.required"));
    if (!KEY_RE.test(draft.key)) return errors.set("key", t("project.keyBad"));
    await run(async () => {
      await mutate(
        { type: "project.create", args: { id: newId(), key: draft.key, name: draft.name.trim(), icon: draft.icon.trim(), color: draft.color, description: draft.description.trim() } },
        undefined,
        { quiet: true },
      );
      toast.info(t("project.created", { name: draft.name.trim() }));
      navigate(`${base}/projects/${draft.key}/statuses`);
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("projects.new")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="project-create" disabled={busy}>
            {t("project.create")}
          </Button>
        </>
      }
    >
      <form id="project-create" onSubmit={submit} className="flex flex-col gap-3.5">
        <ProjectFields draft={draft} set={set} errors={errors} />
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}
