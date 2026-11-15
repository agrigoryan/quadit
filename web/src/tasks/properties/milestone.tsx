// The milestone of its epic a task counts towards, if any.

import { Target } from "lucide-react";
import { t } from "@/lib/i18n";
import { useEpics, useRowEvenIfGone, useRows } from "@/lib/selectors";
import { formatDay } from "@/lib/time";
import { setMilestone } from "@/tasks/actions";
import { PickerRow } from "@/tasks/properties/panel-row";
import { NONE, type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { noneItem } from "@/tasks/property-picker";

/** Shown for a task in an epic: milestones belong to epics. */
function MilestoneRow(panel: PanelProps) {
  const m = useRowEvenIfGone("milestones", panel.task.milestone_id);
  if (!panel.task.epic_id) return null;
  const name = m ? m.name : t("task.noMilestone");
  return (
    <PickerRow property={milestone} panel={panel} value={name} empty={!m}>
      <Target className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="truncate">{name}</span>
    </PickerRow>
  );
}

export const milestone = {
  name: "milestone",
  title: () => t("prop.milestone"),
  picker: {
    title: () => t("prop.set.milestone"),
    useItems: (tasks) => {
      const first = tasks[0];
      const epics = useEpics(first?.project_id);
      const milestones = useRows("milestones");
      return {
        items: [
          noneItem(t("task.noMilestone")),
          ...milestones
            .filter((m) => (!first?.epic_id || m.epic_id === first.epic_id) && epics.some((e) => e.id === m.epic_id))
            .map((m) => ({
              id: m.id,
              label: m.name,
              icon: <Target className="size-3.5 text-ink-2" aria-hidden />,
              hint: m.target_on ? formatDay(m.target_on) : undefined,
            })),
        ],
        value: shared(tasks, (task) => task.milestone_id ?? NONE),
      };
    },
    pick: (tasks, id) => setMilestone(tasks, id === NONE ? null : id),
  },
  Panel: MilestoneRow,
} satisfies TaskProperty<"milestone">;
