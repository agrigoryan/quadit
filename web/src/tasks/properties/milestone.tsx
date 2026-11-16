// The milestone of its epic a task counts towards, if any.

import { Target } from "lucide-react";
import { t } from "@/lib/i18n";
import { getRowEvenIfGone, useEpics, useRowEvenIfGone, useRows } from "@/data/selectors";
import { formatDay } from "@/lib/time";
import { setMilestone } from "@/tasks/actions";
import { PickerRow } from "@/tasks/properties/panel-row";
import { asText, NONE, type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { noneChoice, noneItem } from "@/tasks/property-picker";

function MilestoneRow(panel: PanelProps) {
  const m = useRowEvenIfGone("milestones", panel.task.milestone_id);
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
  // Milestones belong to epics.
  appliesTo: (task) => !!task.epic_id,
  key: { key: "shift+m", shortcut: "shortcuts.milestone" },
  picker: {
    title: () => t("prop.set.milestone"),
    useItems: (tasks) => {
      const epics = useEpics(tasks[0]?.project_id);
      const milestones = useRows("milestones");
      // The epic the tasks are all in ("" for none, where any of the project's will do); tasks in two epics share no milestone.
      const epicId = shared(tasks, (task) => task.epic_id ?? "");
      return {
        items: [
          noneItem(t("task.noMilestone")),
          ...milestones
            .filter((m) => (epicId === "" || m.epic_id === epicId) && epics.some((e) => e.id === m.epic_id))
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
  palette: {
    title: () => t("prop.set.milestone"),
    icon: <Target />,
    useChoices: (task) => [
      noneChoice(t("task.noMilestone"), !task.milestone_id, () => setMilestone([task], null)),
      ...useRows("milestones")
        .filter((m) => m.epic_id === task.epic_id)
        .map((m) => ({
          id: m.id,
          label: m.name,
          detail: m.target_on ? formatDay(m.target_on) : undefined,
          icon: <Target />,
          checked: m.id === task.milestone_id,
          apply: () => setMilestone([task], m.id),
        })),
    ],
  },
  timeline: [
    {
      field: "milestone_id",
      say: (c) => {
        const name = getRowEvenIfGone("milestones", asText(c.to))?.name;
        return name ? t("timeline.milestone", { name }) : c.to ? null : t("timeline.milestoneCleared");
      },
    },
  ],
} satisfies TaskProperty<"milestone">;
