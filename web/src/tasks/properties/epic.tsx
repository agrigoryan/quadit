// The epic a task is part of, if any.

import { Layers } from "lucide-react";
import { t } from "@/lib/i18n";
import { getRowEvenIfGone, useEpics, useRowEvenIfGone } from "@/lib/selectors";
import { setEpic } from "@/tasks/actions";
import { orNone, Pill, pill } from "@/tasks/properties/create-pill";
import { PickerRow } from "@/tasks/properties/panel-row";
import {
  asText,
  type CreateProps,
  NONE,
  type PanelProps,
  shared,
  type TaskProperty,
} from "@/tasks/properties/property";
import { noneItem } from "@/tasks/property-picker";
import { Picker } from "@/ui/picker";

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

/** Offered where the project has epics. */
function EpicPill({ project, value, onChange }: CreateProps) {
  const epics = useEpics(project.id);
  const e = epics.find((x) => x.id === value.epicId);
  if (epics.length === 0) return null;
  return (
    <Picker
      label={t("prop.epic")}
      placeholder={t("prop.set.epic")}
      value={value.epicId || NONE}
      items={[noneItem(t("task.noEpic")), ...epics.map((x) => ({ id: x.id, label: x.name }))]}
      onPick={(id) => onChange({ epicId: orNone(id) })}
    >
      <button type="button" className={pill}>
        <Pill icon={<Layers className="size-3.5" aria-hidden />} set={!!e}>
          {e?.name ?? t("prop.epic")}
        </Pill>
      </button>
    </Picker>
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
  Create: EpicPill,
  bulk: { place: "menu", icon: <Layers />, label: () => t("prop.set.epic") },
  timeline: [
    {
      field: "epic_id",
      say: (c) => {
        const name = getRowEvenIfGone("epics", asText(c.to))?.name;
        return name ? t("timeline.epic", { name }) : c.to ? null : t("timeline.epicCleared");
      },
    },
  ],
} satisfies TaskProperty<"epic">;
