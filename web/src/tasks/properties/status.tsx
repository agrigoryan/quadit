// A task's status: where it is in its project's workflow.

import { CircleDot } from "lucide-react";
import { t, tMaybe } from "@/lib/i18n";
import { useRowEvenIfGone, useStatuses } from "@/lib/selectors";
import { setStatus } from "@/tasks/actions";
import { PickerRow } from "@/tasks/properties/panel-row";
import { type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { StatusIcon } from "@/ui/icons";

function StatusRow(panel: PanelProps) {
  // Named even when it is gone, as everything a task is filed under.
  const s = useRowEvenIfGone("statuses", panel.task.status_id);
  return (
    <PickerRow property={status} panel={panel} value={s?.name ?? ""}>
      {s && <StatusIcon category={s.category} />}
      <span className="truncate">{s?.name}</span>
    </PickerRow>
  );
}

export const status = {
  name: "status",
  title: () => t("prop.status"),
  manage: "statuses",
  picker: {
    title: () => t("prop.set.status"),
    hotkey: "s",
    useItems: (tasks) => ({
      items: useStatuses(tasks[0]?.project_id).map((s) => ({
        id: s.id,
        label: s.name,
        icon: <StatusIcon category={s.category} />,
        keywords: tMaybe(`category.${s.category}`),
      })),
      value: shared(tasks, (task) => task.status_id),
    }),
    pick: setStatus,
  },
  Panel: StatusRow,
  bulk: { place: "bar", icon: <CircleDot className="size-3.5" aria-hidden /> },
} satisfies TaskProperty<"status">;
