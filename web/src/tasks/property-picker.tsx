import type { ReactNode, RefObject } from "react";
import { CircleSlash, Layers, RefreshCw, Target } from "lucide-react";
import { t, tMaybe } from "@/lib/i18n";
import { useCycles, useEpics, useLabels, useMe, useMembers, useStatuses } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import type { Member, Task } from "@/lib/types";
import { formatDay } from "@/lib/time";
import { setAssignee, setCycle, setEpic, setMilestone, setPriority, setStatus, setWaitingOn, toggleLabel } from "@/tasks/actions";
import { Avatar } from "@/ui/avatar";
import { PriorityIcon, StatusIcon } from "@/ui/icons";
import { Picker, type PickerItem } from "@/ui/picker";

export type TaskProperty = "status" | "assignee" | "waiting" | "priority" | "labels" | "epic" | "milestone" | "cycle";

const NONE = "none";
const noneIcon = <CircleSlash className="size-3.5 text-ink-3" aria-hidden />;

export const PRIORITIES = [0, 1, 2, 3, 4];

/** People and agents as picker rows, "me" first. */
export function memberItems(members: Member[], meId: string | undefined): PickerItem[] {
  return [...members]
    .sort((a, b) => Number(b.user_id === meId) - Number(a.user_id === meId))
    .map((m) => ({
      id: m.user_id,
      label: m.name,
      icon: <Avatar member={m} size="xs" />,
      hint: m.kind === "agent" ? t("common.agent") : undefined,
      keywords: `@${m.handle}`,
    }));
}

/** The rows a picker offers for one property, and what is picked now. */
function useItems(kind: TaskProperty, tasks: Task[]): { items: PickerItem[]; value: string | string[] | undefined } {
  const first = tasks[0];
  const projectId = first?.project_id;
  const statuses = useStatuses(kind === "status" ? projectId : undefined);
  const members = useMembers();
  const me = useMe();
  const labels = useLabels(projectId);
  const epics = useEpics(projectId);
  const cycles = useCycles(projectId);
  const milestones = useStore((s) => s.c.milestones);
  const same = <T,>(get: (task: Task) => T) => (tasks.every((task) => get(task) === get(first as Task)) ? get(first as Task) : undefined);

  switch (kind) {
    case "status":
      return {
        items: statuses.map((s) => ({ id: s.id, label: s.name, icon: <StatusIcon category={s.category} />, keywords: tMaybe(`category.${s.category}`) })),
        value: same((task) => task.status_id),
      };
    case "assignee":
    case "waiting":
      return {
        items: [{ id: NONE, label: kind === "assignee" ? t("task.unassigned") : t("prop.nobody"), icon: noneIcon }, ...memberItems(members, me.user_id)],
        value: same((task) => (kind === "assignee" ? task.assignee_id : task.waiting_on_id) ?? NONE),
      };
    case "priority":
      return {
        items: PRIORITIES.map((p) => ({ id: String(p), label: t(`priority.${p}` as "priority.0"), icon: <PriorityIcon priority={p} title="" />, hint: String(p) })),
        value: same((task) => String(task.priority)),
      };
    case "labels":
      return {
        items: labels.map((l) => ({
          id: l.id,
          label: l.name,
          icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
        })),
        value: labels.filter((l) => tasks.every((task) => task.label_ids?.includes(l.id))).map((l) => l.id),
      };
    case "epic":
      return {
        items: [
          { id: NONE, label: t("task.noEpic"), icon: noneIcon },
          ...epics.map((e) => ({ id: e.id, label: e.name, icon: <Layers className="size-3.5 text-ink-2" aria-hidden /> })),
        ],
        value: same((task) => task.epic_id ?? NONE),
      };
    case "milestone":
      return {
        items: [
          { id: NONE, label: t("task.noMilestone"), icon: noneIcon },
          ...Object.values(milestones)
            .filter((m) => !m.deleted_at && (!first?.epic_id || m.epic_id === first.epic_id) && epics.some((e) => e.id === m.epic_id))
            .map((m) => ({
              id: m.id,
              label: m.name,
              icon: <Target className="size-3.5 text-ink-2" aria-hidden />,
              hint: m.target_on ? formatDay(m.target_on) : undefined,
            })),
        ],
        value: same((task) => task.milestone_id ?? NONE),
      };
    case "cycle":
      return {
        items: [
          { id: NONE, label: t("task.noCycle"), icon: noneIcon },
          ...cycles.map((c) => ({
            id: c.id,
            label: c.name || t("prop.cycleName", { n: c.number }),
            icon: <RefreshCw className="size-3.5 text-ink-2" aria-hidden />,
            hint: `${formatDay(c.starts_on)} – ${formatDay(c.ends_on)}`,
          })),
        ],
        value: same((task) => task.cycle_id ?? NONE),
      };
  }
}

function apply(kind: TaskProperty, tasks: Task[], id: string) {
  const value = id === NONE ? null : id;
  switch (kind) {
    case "status":
      return setStatus(tasks, id);
    case "assignee":
      return setAssignee(tasks, value);
    case "waiting":
      return setWaitingOn(tasks, value);
    case "priority":
      return setPriority(tasks, Number(id));
    case "labels":
      return toggleLabel(tasks, id);
    case "epic":
      return setEpic(tasks, value);
    case "milestone":
      return setMilestone(tasks, value);
    case "cycle":
      return setCycle(tasks, value);
  }
}

const titles: Record<TaskProperty, () => string> = {
  status: () => t("prop.set.status"),
  assignee: () => t("prop.set.assignee"),
  waiting: () => t("prop.set.waitingOn"),
  priority: () => t("prop.set.priority"),
  labels: () => t("prop.set.labels"),
  epic: () => t("prop.set.epic"),
  milestone: () => t("prop.set.milestone"),
  cycle: () => t("prop.set.cycle"),
};

interface Props {
  kind: TaskProperty;
  /** The tasks to change: one, or a whole selection. */
  tasks: Task[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the picker. */
  children?: ReactNode;
  /** Open next to this element instead (for keyboard shortcuts). */
  anchor?: RefObject<Element | null>;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}

/** Changes one property of one or many tasks. Used by rows, the bulk bar, the task panel and the palette. */
export function TaskPropertyPicker({ kind, tasks, ...rest }: Props) {
  const { items, value } = useItems(kind, tasks);
  return (
    <Picker
      {...rest}
      items={items}
      value={value}
      multiple={kind === "labels"}
      label={titles[kind]()}
      placeholder={titles[kind]()}
      onPick={(id) => apply(kind, tasks, id)}
    />
  );
}
