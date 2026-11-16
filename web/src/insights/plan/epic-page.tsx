// One epic in full: what it is for, its state, lead and dates, how far
// along it is, and its tasks by milestone.

import { useState } from "react";
import { ChevronLeft, Ellipsis, Eye, EyeOff, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { t } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { useMe, useMembers, useProjectByKey, useRow, useSlug } from "@/data/selectors";
import type { Epic, Project } from "@/types/core";
import { ui, usePageTitle } from "@/lib/ui-state";
import { useEscapeBack } from "@/nav/escape-back";
import { setWatchingEpic, updateEpic } from "@/insights/plan/actions";
import { EpicDescription } from "@/insights/plan/epic-description";
import { EpicDialog } from "@/insights/plan/epic-dialog";
import { EpicMilestones } from "@/insights/plan/epic-milestones";
import { EPIC_STATES, emptyTally, epicStateName, riskLabel, riskOf, useTallies } from "@/insights/plan/stats";
import { PageBar } from "@/insights/ui/panel";
import { Progress } from "@/insights/ui/progress";
import { DeleteEpic } from "@/insights/plan/delete-epic";
import { useTasksBy } from "@/insights/plan/tasks-by";
import { NotFoundPage } from "@/ui/not-found";
import { Avatar } from "@/ui/avatar";
import { Button, IconButton } from "@/ui/button";
import { Input } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { Select } from "@/ui/picker";

const NOBODY = "none";

export function EpicPage() {
  const { key, id } = useParams();
  const project = useProjectByKey(key);
  const epic = useRow("epics", id);
  if (!project || !epic || epic.project_id !== project.id) return <NotFoundPage />;
  return <EpicView project={project} epic={epic} />;
}

function EpicView({ project, epic }: { project: Project; epic: Epic }) {
  usePageTitle(epic.name);
  const slug = useSlug();
  const me = useMe();
  const navigate = useNavigate();
  const members = useMembers();
  const tasks = useTasksBy(project.id, "epic_id")[epic.id] ?? [];
  const tally = useTallies("epic_id")[epic.id] ?? emptyTally();
  const watching = !!useRow("watchers", `${me.user_id}:${epic.id}`);
  const can = useCan();
  const readOnly = !can.edit(project.id);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const risk = riskOf(epic, tally);
  const list = `/${slug}/p/${project.key}/epics`;
  useEscapeBack(list);
  const backwards = (start: string, target: string) => !!start && !!target && target < start;

  return (
    <div className="flex h-full flex-col">
      <PageBar>
        <Link
          to={list}
          className="flex h-7 items-center gap-1 rounded-md pr-2 pl-1 text-sm text-ink-2 hover:bg-hover hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {t("nav.epics")}
        </Link>
        <span className="flex-1" />
        {can.write && (
          <Button variant="ghost" aria-pressed={watching} onClick={() => setWatchingEpic(epic, me.user_id, !watching)}>
            {watching ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            <span className="max-sm:sr-only">{watching ? t("epic.unwatch") : t("epic.watch")}</span>
          </Button>
        )}
        {!readOnly && (
          <Button onClick={() => ui.newTask({ projectId: project.id, epicId: epic.id })}>
            <Plus className="size-4" aria-hidden />
            {t("epic.addTask")}
          </Button>
        )}
        {!readOnly && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={t("epic.actions", { name: epic.name })}>
                <Ellipsis className="size-4" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                {t("common.edit")}
              </MenuItem>
              <MenuItem icon={<Trash2 />} danger onSelect={() => setDeleting(true)}>
                {t("epic.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </PageBar>

      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <div className="px-4 pt-4 pb-4 md:px-6">
          <h1 className="text-lg font-semibold">{epic.name}</h1>
          <EpicDescription epic={epic} readOnly={readOnly} />

          <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-3">
            <Labelled label={t("epic.state")}>
              <Select
                items={EPIC_STATES.map((s) => ({ id: s, label: epicStateName(s) }))}
                value={epic.state}
                onPick={(state) => updateEpic(epic, { state })}
                label={t("epic.state")}
                buttonProps={{ className: "h-8 min-w-28", disabled: readOnly }}
              />
            </Labelled>
            <Labelled label={t("epic.lead")}>
              <Select
                items={[
                  { id: NOBODY, label: t("epic.noLead"), icon: <Avatar member={undefined} size="xs" /> },
                  ...members.map((m) => ({
                    id: m.user_id,
                    label: m.name,
                    icon: <Avatar member={m} size="xs" />,
                    keywords: m.handle,
                  })),
                ]}
                value={epic.lead_id ?? NOBODY}
                onPick={(id) => updateEpic(epic, { lead: id === NOBODY ? null : id })}
                label={t("epic.lead")}
                buttonProps={{ className: "h-8 min-w-36", disabled: readOnly }}
              />
            </Labelled>
            <Labelled label={t("epic.start")}>
              <Input
                type="date"
                value={epic.start_on ?? ""}
                max={epic.target_on}
                disabled={readOnly}
                onChange={(e) =>
                  !backwards(e.target.value, epic.target_on ?? "") &&
                  updateEpic(epic, { start_on: e.target.value || null })
                }
                className="w-[9rem] tnum"
              />
            </Labelled>
            <Labelled label={t("epic.target")}>
              <Input
                type="date"
                value={epic.target_on ?? ""}
                min={epic.start_on}
                disabled={readOnly}
                onChange={(e) =>
                  !backwards(epic.start_on ?? "", e.target.value) &&
                  updateEpic(epic, { target_on: e.target.value || null })
                }
                className="w-[9rem] tnum"
              />
            </Labelled>
          </div>

          <div className="mt-4 max-w-xl">
            <div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-xs text-ink-2 tnum">
              <span>
                {tally.started > 0
                  ? t("ins.progress.withStarted", { done: tally.done, started: tally.started, total: tally.total })
                  : t("ins.progress", { done: tally.done, total: tally.total })}
              </span>
              {tally.points > 0 && (
                <span className="text-ink-3">{t("ins.points", { done: tally.pointsDone, total: tally.points })}</span>
              )}
            </div>
            <Progress done={tally.done} started={tally.started} total={tally.total} />
            {risk && (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-wait">
                <TriangleAlert className="size-3 shrink-0" aria-hidden />
                {t("dash.epics.atRisk", { why: riskLabel(risk) })}
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-line">
          <EpicMilestones epic={epic} tasks={tasks} readOnly={readOnly} />
        </div>
      </div>

      {editing && <EpicDialog projectId={project.id} epic={epic} onClose={() => setEditing(false)} />}
      {deleting && <DeleteEpic epic={epic} onClose={() => setDeleting(false)} onDeleted={() => navigate(list)} />}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
      {label}
      {children}
    </label>
  );
}
