// The cycle (a project's run of days) a task is planned for, if any.

import { RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { getRowEvenIfGone, useCycles, useRowEvenIfGone } from "@/lib/selectors";
import { formatDay } from "@/lib/time";
import type { Cycle } from "@/lib/types";
import { setCycle } from "@/tasks/actions";
import { PickerRow } from "@/tasks/properties/panel-row";
import { asText, NONE, type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { noneItem } from "@/tasks/property-picker";

/** "Cycle 4", where it has no name of its own. */
export const cycleName = (c: Cycle) => c.name || t("prop.cycleName", { n: String(c.number) });

/** Shown where the task's project works in cycles. */
function CycleRow(panel: PanelProps) {
  const project = useRowEvenIfGone("projects", panel.task.project_id);
  const c = useRowEvenIfGone("cycles", panel.task.cycle_id);
  if (!project?.settings?.cycles) return null;
  const name = c ? cycleName(c) : t("task.noCycle");
  return (
    <PickerRow property={cycle} panel={panel} value={name} empty={!c}>
      <RefreshCw className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="truncate">{name}</span>
    </PickerRow>
  );
}

export const cycle = {
  name: "cycle",
  title: () => t("prop.cycle"),
  picker: {
    title: () => t("prop.set.cycle"),
    useItems: (tasks) => ({
      items: [
        noneItem(t("task.noCycle")),
        ...useCycles(tasks[0]?.project_id).map((c) => ({
          id: c.id,
          label: cycleName(c),
          icon: <RefreshCw className="size-3.5 text-ink-2" aria-hidden />,
          hint: `${formatDay(c.starts_on)} – ${formatDay(c.ends_on)}`,
        })),
      ],
      value: shared(tasks, (task) => task.cycle_id ?? NONE),
    }),
    pick: (tasks, id) => setCycle(tasks, id === NONE ? null : id),
  },
  Panel: CycleRow,
  bulk: {
    place: "menu",
    icon: <RefreshCw />,
    label: () => t("prop.set.cycle"),
    offered: (project) => !!project?.settings?.cycles,
  },
  timeline: [
    {
      field: "cycle_id",
      say: (c) => {
        const row = getRowEvenIfGone("cycles", asText(c.to));
        if (row) return t("timeline.cycle", { name: cycleName(row) });
        return c.to ? null : t("timeline.cycleCleared");
      },
    },
  ],
} satisfies TaskProperty<"cycle">;
