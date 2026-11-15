// Everything a task is filed under, as one dense block of label and value
// rows: two columns of rows on a wide panel, one on a phone. The S, A, P
// and L keys open the status, assignee, priority and label pickers.

import { useRef, useState } from "react";
import { Globe, Layers, RefreshCw, Target } from "lucide-react";
import { useHotkeys } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { useMe, useMember } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { nameOf } from "@/detail/data";
import { BudgetField } from "@/detail/budget-field";
import { DueField, EstimateField, ParentField, PropButton, PropRow, WaitingNote } from "@/detail/property-fields";
import { waitsOutside } from "@/tasks/actions";
import { TaskPropertyPicker, type TaskProperty } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { LabelChip } from "@/ui/badge";
import { PriorityIcon, StatusIcon } from "@/ui/icons";
import { Tooltip } from "@/ui/tooltip";

type Keyed = "status" | "assignee" | "priority" | "labels";
const KEYS: Record<string, Keyed> = { s: "status", a: "assignee", p: "priority", l: "labels" };

export function Properties({ task }: { task: Task }) {
  const me = useMe();
  const project = useStore((s) => s.c.projects[task.project_id]);
  const status = useStore((s) => s.c.statuses[task.status_id]);
  const labels = useStore((s) => s.c.labels);
  const epic = useStore((s) => (task.epic_id ? s.c.epics[task.epic_id] : undefined));
  const milestone = useStore((s) => (task.milestone_id ? s.c.milestones[task.milestone_id] : undefined));
  const cycle = useStore((s) => (task.cycle_id ? s.c.cycles[task.cycle_id] : undefined));
  const assignee = useMember(task.assignee_id);
  const askedBy = useMember(task.asked_by);
  const waitingOn = useMember(task.waiting_on_id);
  const holder = useMember(task.lease_holder_id);
  const readOnly = !!task.deleted_at;
  const held = holder && (task.lease_until ?? 0) > Date.now();
  const waitsOnMe = waitingOn?.user_id === me.user_id;
  const outside = waitsOutside(task);

  // Which picker a key opened, and the buttons they open next to.
  const [opened, setOpened] = useState<Keyed | null>(null);
  const triggers = useRef<Partial<Record<Keyed, HTMLButtonElement | null>>>({});

  const hotkeys = Object.fromEntries(
    Object.entries(KEYS).map(([key, kind]) => [
      key,
      (e: KeyboardEvent) => {
        if (readOnly) return;
        e.preventDefault();
        triggers.current[kind]?.scrollIntoView({ block: "nearest" });
        setOpened(kind);
      },
    ]),
  );
  useHotkeys(hotkeys, { layer: "panel" });

  const picker = (kind: Keyed) => ({
    kind: kind as TaskProperty,
    tasks: [task],
    open: opened === kind,
    onOpenChange: (open: boolean) => setOpened(open ? kind : null),
  });
  const trigger = (kind: Keyed) => ({
    ref: (el: HTMLButtonElement | null) => {
      triggers.current[kind] = el;
    },
    disabled: readOnly,
  });

  const cycleName = cycle ? cycle.name || t("prop.cycleName", { n: cycle.number }) : t("task.noCycle");
  const taskLabels = (task.label_ids ?? []).map((id) => labels[id]).filter((l) => l !== undefined);

  return (
    <section aria-label={t("detail.properties")} className="border-t border-line px-4 py-2.5 md:px-6">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
        <PropRow label={t("prop.status")}>
          <TaskPropertyPicker {...picker("status")}>
            <PropButton {...trigger("status")} aria-label={`${t("prop.status")}: ${status?.name ?? ""}`}>
              {status && <StatusIcon category={status.category} />}
              <span className="truncate">{status?.name}</span>
            </PropButton>
          </TaskPropertyPicker>
        </PropRow>

        <PropRow label={t("prop.assignee")}>
          <TaskPropertyPicker {...picker("assignee")}>
            <PropButton {...trigger("assignee")} empty={!assignee} aria-label={`${t("prop.assignee")}: ${assignee ? assignee.name : t("task.unassigned")}`}>
              <Avatar member={assignee} size="xs" />
              <span className="truncate">{assignee ? assignee.name : t("task.unassigned")}</span>
            </PropButton>
          </TaskPropertyPicker>
        </PropRow>

        {askedBy && assignee?.kind === "agent" && (
          <PropRow label={t("prop.workingFor")} wide>
            <Tooltip label={t("prop.workingForHint", { name: askedBy.name })}>
              <span tabIndex={0} className="flex h-7 min-w-0 max-w-full cursor-default items-center gap-1.5 rounded-md text-sm text-ink-2 max-md:h-9">
                <Avatar member={askedBy} size="xs" />
                <span className="truncate">{askedBy.name}</span>
              </span>
            </Tooltip>
          </PropRow>
        )}

        <PropRow label={t("prop.waitingOn")} wide>
          <TaskPropertyPicker kind="waiting" tasks={[task]}>
            <PropButton
              empty={!waitingOn && !outside}
              disabled={readOnly}
              aria-label={`${t("prop.waitingOn")}: ${outside ? t("prop.outside") : waitingOn ? nameOf(waitingOn) : t("prop.nobody")}`}
            >
              {outside ? (
                <>
                  <Globe className="size-3.5 shrink-0 text-wait" aria-hidden />
                  <span className="truncate">{t("prop.outside.label")}</span>
                </>
              ) : waitingOn ? (
                waitsOnMe ? (
                  <span className="flex h-5 items-center gap-1.5 rounded-sm bg-move px-1.5 font-semibold text-move-ink">
                    <Avatar member={waitingOn} size="xs" />
                    {t("detail.waitingYou")}
                  </span>
                ) : (
                  <>
                    <Avatar member={waitingOn} size="xs" />
                    <span className="truncate">{nameOf(waitingOn)}</span>
                  </>
                )
              ) : (
                t("prop.nobody")
              )}
            </PropButton>
          </TaskPropertyPicker>
          {(waitingOn || outside) && <WaitingNote task={task} />}
        </PropRow>

        <PropRow label={t("prop.priority")}>
          <TaskPropertyPicker {...picker("priority")}>
            <PropButton {...trigger("priority")} empty={!task.priority} aria-label={`${t("prop.priority")}: ${t(`priority.${task.priority}` as "priority.0")}`}>
              <PriorityIcon priority={task.priority} title="" />
              <span className="truncate">{t(`priority.${task.priority}` as "priority.0")}</span>
            </PropButton>
          </TaskPropertyPicker>
        </PropRow>

        <PropRow label={t("prop.labels")}>
          <TaskPropertyPicker {...picker("labels")}>
            <PropButton
              {...trigger("labels")}
              empty={taskLabels.length === 0}
              aria-label={`${t("prop.labels")}: ${taskLabels.length ? taskLabels.map((l) => l.name).join(", ") : t("task.noLabels")}`}
              className="h-auto min-h-7 flex-wrap gap-1 py-1 max-md:h-auto max-md:min-h-9"
            >
              {taskLabels.length === 0
                ? t("task.noLabels")
                : taskLabels.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} />)}
            </PropButton>
          </TaskPropertyPicker>
        </PropRow>

        <PropRow label={t("prop.epic")}>
          <TaskPropertyPicker kind="epic" tasks={[task]}>
            <PropButton empty={!epic} disabled={readOnly} aria-label={`${t("prop.epic")}: ${epic ? epic.name : t("task.noEpic")}`}>
              <Layers className="size-3.5 shrink-0 text-ink-3" aria-hidden />
              <span className="truncate">{epic ? epic.name : t("task.noEpic")}</span>
            </PropButton>
          </TaskPropertyPicker>
        </PropRow>

        {task.epic_id && (
          <PropRow label={t("prop.milestone")}>
            <TaskPropertyPicker kind="milestone" tasks={[task]}>
              <PropButton empty={!milestone} disabled={readOnly} aria-label={`${t("prop.milestone")}: ${milestone ? milestone.name : t("task.noMilestone")}`}>
                <Target className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                <span className="truncate">{milestone ? milestone.name : t("task.noMilestone")}</span>
              </PropButton>
            </TaskPropertyPicker>
          </PropRow>
        )}

        {project?.settings?.cycles && (
          <PropRow label={t("prop.cycle")}>
            <TaskPropertyPicker kind="cycle" tasks={[task]}>
              <PropButton empty={!cycle} disabled={readOnly} aria-label={`${t("prop.cycle")}: ${cycleName}`}>
                <RefreshCw className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                <span className="truncate">{cycleName}</span>
              </PropButton>
            </TaskPropertyPicker>
          </PropRow>
        )}

        {project?.settings?.estimates && (
          <PropRow label={t("prop.estimate")}>
            <EstimateField task={task} />
          </PropRow>
        )}

        <PropRow label={t("prop.due")}>
          <DueField task={task} />
        </PropRow>

        <PropRow label={t("prop.parent")}>
          <ParentField task={task} />
        </PropRow>

        {me.role !== "member" && (
          <PropRow label={t("prop.budget")}>
            <BudgetField task={task} />
          </PropRow>
        )}
      </dl>

      {held && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-2">
          <Avatar member={holder} size="xs" />
          {t("task.heldBy", { name: nameOf(holder) })}
        </p>
      )}
    </section>
  );
}
