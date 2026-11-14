import { type FormEvent, useState } from "react";
import { Layers, Plus } from "lucide-react";
import { useParams } from "react-router";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { send } from "@/lib/mutate";
import { useEpics, useMember, useProjectByKey } from "@/lib/selectors";
import { formatDay } from "@/lib/time";
import type { Epic, Project } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { PlanRow, useTasksBy } from "@/pages/plan-parts";
import { NotFoundPage } from "@/shell/placeholders";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Input } from "@/ui/input";

const tones = { planned: "neutral", active: "accent", paused: "wait", done: "ok", canceled: "neutral" } as const;

/** A project's epics: each with its state, lead, target date and how far along its tasks are. */
export function EpicsPage() {
  const project = useProjectByKey(useParams().key);
  return project ? <Epics project={project} /> : <NotFoundPage />;
}

function Epics({ project }: { project: Project }) {
  usePageTitle(t("epics.pageTitle", { project: project.name }));
  const epics = useEpics(project.id);
  const tasksBy = useTasksBy(project.id, "epic_id");
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line pr-2 pl-4">
        <p className="flex-1 text-xs text-ink-2 tnum max-sm:hidden">{t("epics.count", { n: epics.length })}</p>
        <NewEpic projectId={project.id} />
      </header>
      {epics.length === 0 ? (
        <EmptyState icon={<Layers />} title={t("epics.empty")} hint={t("epics.emptyHint")} />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto pb-10">
          {epics.map((epic) => (
            <PlanRow
              key={epic.id}
              name={epic.name}
              badge={<Badge tone={tones[epic.state] ?? "neutral"}>{t(`epics.state.${epic.state}` as "epics.state.planned")}</Badge>}
              meta={<EpicMeta epic={epic} />}
              tasks={tasksBy[epic.id] ?? []}
              open={openId === epic.id}
              onToggle={() => setOpenId(openId === epic.id ? null : epic.id)}
              emptyText={t("epics.noTasks")}
              hide={{ epic: true }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EpicMeta({ epic }: { epic: Epic }) {
  const lead = useMember(epic.lead_id);
  return (
    <>
      {epic.target_on && (
        <span className="shrink-0 text-xs text-ink-3 tnum max-sm:hidden">{t("epics.target", { day: formatDay(epic.target_on) })}</span>
      )}
      <span className="flex w-5 shrink-0 justify-center">{lead && <Avatar member={lead} size="sm" />}</span>
    </>
  );
}

function NewEpic({ projectId }: { projectId: string }) {
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = newId();
    send({ type: "epic.create", args: { id, project: projectId, name: trimmed } }, (tx) =>
      tx.insert("epics", { id, project_id: projectId, name: trimmed, state: "planned", rank: "zz" }),
    );
    setName("");
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2 max-sm:flex-1">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("epics.namePlaceholder")}
        aria-label={t("epics.namePlaceholder")}
        maxLength={120}
        className="h-7 sm:w-64"
      />
      <Button type="submit" disabled={!name.trim()}>
        <Plus className="size-4" aria-hidden />
        {t("epics.create")}
      </Button>
    </form>
  );
}
