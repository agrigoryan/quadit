// A task's labels: any number of its project's (or the workspace's) labels.

import { t } from "@/lib/i18n";
import { useLabels, useLookupEvenIfGone } from "@/lib/selectors";
import { toggleLabel } from "@/tasks/actions";
import { createLabel, createLabelText } from "@/tasks/manage";
import { PickerRow } from "@/tasks/properties/panel-row";
import type { PanelProps, TaskProperty } from "@/tasks/properties/property";
import { LabelChip } from "@/ui/badge";

function LabelRow(panel: PanelProps) {
  // A deleted label the task still has is named.
  const labels = useLookupEvenIfGone("labels");
  const own = (panel.task.label_ids ?? []).map((id) => labels[id]).filter((l) => l !== undefined);
  return (
    <PickerRow
      property={label}
      panel={panel}
      value={own.length ? own.map((l) => l.name).join(", ") : t("task.noLabels")}
      empty={own.length === 0}
      className="h-auto min-h-7 flex-wrap gap-1 py-1 max-md:h-auto max-md:min-h-9"
    >
      {own.length === 0 ? t("task.noLabels") : own.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} />)}
    </PickerRow>
  );
}

export const label = {
  name: "label",
  title: () => t("prop.labels"),
  make: { run: createLabel, label: createLabelText },
  manage: "labels",
  picker: {
    title: () => t("prop.set.labels"),
    hotkey: "l",
    multiple: true,
    useItems: (tasks) => {
      const labels = useLabels(tasks[0]?.project_id);
      return {
        items: labels.map((l) => ({
          id: l.id,
          label: l.name,
          icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
        })),
        value: labels.filter((l) => tasks.every((task) => task.label_ids?.includes(l.id))).map((l) => l.id),
      };
    },
    pick: toggleLabel,
  },
  Panel: LabelRow,
} satisfies TaskProperty<"label">;
