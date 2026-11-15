// A project's epics, as a list of rows.

import { useState } from "react";
import { Ellipsis, Layers, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { t } from "@/lib/i18n";
import { useEpics, useMember, useProjectByKey, useSlug } from "@/lib/selectors";
import { formatDay } from "@/lib/time";
import type { Epic, Project } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { DeleteEpic } from "@/insights/plan/delete-epic";
import { EpicDialog } from "@/insights/plan/epic-dialog";
import { epicStateName, epicTones, riskLabel, riskOf, type Tally, useTallies } from "@/insights/plan/stats";
import { PlanRow } from "@/insights/plan/plan-row";
import { useTasksBy } from "@/insights/plan/tasks-by";
import { NotFoundPage } from "@/ui/not-found";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { Tooltip } from "@/ui/tooltip";

/** A project's epics: each with its state, lead, dates, how far along its tasks are, and whether it is at risk. */
export function EpicsPage() {
  const project = useProjectByKey(useParams().key);
  return project ? <Epics project={project} /> : <NotFoundPage />;
}

/** "Oct 20 to Dec 18", or the one date there is. */
function epicDates(epic: Epic): string {
  if (epic.start_on && epic.target_on)
    return t("cycles.range", { from: formatDay(epic.start_on), to: formatDay(epic.target_on) });
  if (epic.target_on) return t("epics.target", { day: formatDay(epic.target_on) });
  if (epic.start_on) return t("epic.starts", { day: formatDay(epic.start_on) });
  return "";
}

function Epics({ project }: { project: Project }) {
  usePageTitle(t("epics.pageTitle", { project: project.name }));
  const slug = useSlug();
  const navigate = useNavigate();
  const epics = useEpics(project.id);
  const tasksBy = useTasksBy(project.id, "epic_id");
  const tallies = useTallies("epic_id");
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ epic?: Epic } | null>(null);
  const [deleting, setDeleting] = useState<Epic | null>(null);
  const pageOf = (id: string) => `/${slug}/p/${project.key}/epics/${id}`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line pr-2 pl-4">
        <p className="flex-1 text-xs text-ink-2 tnum">{t("epics.count", { n: epics.length })}</p>
        <Button onClick={() => setDialog({})}>
          <Plus className="size-4" aria-hidden />
          {t("epic.new")}
        </Button>
      </header>
      {epics.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title={t("epics.empty")}
          hint={t("epic.emptyHint")}
          action={
            <Button variant="primary" onClick={() => setDialog({})}>
              <Plus className="size-4" aria-hidden />
              {t("epic.new")}
            </Button>
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto pb-10">
          {epics.map((epic) => (
            <PlanRow
              key={epic.id}
              name={epic.name}
              to={pageOf(epic.id)}
              badge={<EpicBadges epic={epic} tally={tallies[epic.id]} />}
              meta={<EpicMeta epic={epic} />}
              menu={
                <Menu>
                  <MenuTrigger asChild>
                    <IconButton label={t("epic.actions", { name: epic.name })} size="sm">
                      <Ellipsis className="size-4" />
                    </IconButton>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem icon={<Pencil />} onSelect={() => setDialog({ epic })}>
                      {t("common.edit")}
                    </MenuItem>
                    <MenuItem icon={<Trash2 />} danger onSelect={() => setDeleting(epic)}>
                      {t("epic.delete")}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              }
              tally={tallies[epic.id]}
              tasks={tasksBy[epic.id] ?? []}
              open={openId === epic.id}
              onToggle={() => setOpenId(openId === epic.id ? null : epic.id)}
              emptyText={t("epics.noTasks")}
              hide={{ epic: true }}
            />
          ))}
        </ul>
      )}
      {dialog && (
        <EpicDialog
          projectId={project.id}
          epic={dialog.epic}
          onClose={() => setDialog(null)}
          onCreated={(id) => navigate(pageOf(id))}
        />
      )}
      {deleting && <DeleteEpic epic={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function EpicBadges({ epic, tally }: { epic: Epic; tally: Tally | undefined }) {
  const risk = riskOf(epic, tally);
  return (
    <>
      <Badge tone={epicTones[epic.state] ?? "neutral"}>{epicStateName(epic.state)}</Badge>
      {risk && (
        <Tooltip label={t("dash.epics.atRisk", { why: riskLabel(risk) })} side="top">
          <span
            tabIndex={0}
            className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm bg-wait-soft px-1.5 text-xs font-medium text-wait"
          >
            <TriangleAlert className="size-3" aria-hidden />
            <span className="max-sm:sr-only">{t("epic.atRisk")}</span>
          </span>
        </Tooltip>
      )}
    </>
  );
}

function EpicMeta({ epic }: { epic: Epic }) {
  const lead = useMember(epic.lead_id);
  return (
    <>
      <span className="shrink-0 text-xs text-ink-3 tnum max-md:hidden">{epicDates(epic)}</span>
      <span className="flex w-5 shrink-0 justify-center max-sm:hidden">
        {lead && <Avatar member={lead} size="sm" />}
      </span>
    </>
  );
}
