// The epic a task is part of, if any.

import { Layers } from "lucide-react";
import { t } from "@/lib/i18n";
import { useEpics, useRowEvenIfGone } from "@/lib/selectors";
import { setEpic } from "@/tasks/actions";
import { PickerRow } from "@/tasks/properties/panel-row";
import { NONE, type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { noneItem } from "@/tasks/property-picker";

function EpicRow(panel: PanelProps) {
  const e = useRowEvenIfGone("epics", panel.task.epic_id);
  const name = e ? e.name : t("task.noEpic");
  return (
    <PickerRow property={epic} panel={panel} value={name} empty={!e}>
      <Layers className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="truncate">{name}</span>
    </PickerRow>
  );
}

export const epic = {
  name: "epic",
  title: () => t("prop.epic"),
  picker: {
    title: () => t("prop.set.epic"),
    useItems: (tasks) => ({
      items: [
        noneItem(t("task.noEpic")),
        ...useEpics(tasks[0]?.project_id).map((e) => ({
          id: e.id,
          label: e.name,
          icon: <Layers className="size-3.5 text-ink-2" aria-hidden />,
        })),
      ],
      value: shared(tasks, (task) => task.epic_id ?? NONE),
    }),
    pick: (tasks, id) => setEpic(tasks, id === NONE ? null : id),
  },
  Panel: EpicRow,
  bulk: { place: "menu", icon: <Layers />, label: () => t("prop.set.epic") },
} satisfies TaskProperty<"epic">;
