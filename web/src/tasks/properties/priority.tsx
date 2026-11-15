// How urgent a task is: 1 (urgent) to 4 (low), or 0 for none.

import { SignalHigh } from "lucide-react";
import { t, tMaybe } from "@/lib/i18n";
import { setPriority } from "@/tasks/actions";
import { Pill, pill } from "@/tasks/properties/create-pill";
import { PickerRow } from "@/tasks/properties/panel-row";
import { type CreateProps, type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { PriorityIcon } from "@/ui/icons";
import { Picker } from "@/ui/picker";

function PriorityRow(panel: PanelProps) {
  const p = panel.task.priority;
  const name = t(`priority.${p}` as "priority.0");
  return (
    <PickerRow property={priority} panel={panel} value={name} empty={!p}>
      <PriorityIcon priority={p} title="" />
      <span className="truncate">{name}</span>
    </PickerRow>
  );
}

/** Every priority, "no priority" first. */
export const PRIORITIES = [0, 1, 2, 3, 4];

function PriorityPill({ value, onChange }: CreateProps) {
  return (
    <Picker
      label={t("prop.priority")}
      placeholder={t("prop.set.priority")}
      value={String(value.priority)}
      items={PRIORITIES.map((p) => ({
        id: String(p),
        label: tMaybe(`priority.${p}`),
        icon: <PriorityIcon priority={p} title="" />,
      }))}
      onPick={(id) => onChange({ priority: Number(id) })}
    >
      <button type="button" className={pill}>
        <Pill icon={<PriorityIcon priority={value.priority} title="" />} set={value.priority > 0}>
          {value.priority > 0 ? tMaybe(`priority.${value.priority}`) : t("prop.priority")}
        </Pill>
      </button>
    </Picker>
  );
}

export const priority = {
  name: "priority",
  title: () => t("prop.priority"),
  picker: {
    title: () => t("prop.set.priority"),
    hotkey: { key: "p", shortcut: "shortcuts.priority" },
    useItems: (tasks) => ({
      items: PRIORITIES.map((p) => ({
        id: String(p),
        label: t(`priority.${p}` as "priority.0"),
        icon: <PriorityIcon priority={p} title="" />,
        hint: String(p),
      })),
      value: shared(tasks, (task) => String(task.priority)),
    }),
    pick: (tasks, id) => setPriority(tasks, Number(id)),
  },
  Panel: PriorityRow,
  Create: PriorityPill,
  palette: {
    icon: <SignalHigh />,
    // Urgent first and "no priority" last, unlike the picker's list.
    useChoices: (task) =>
      [1, 2, 3, 4, 0].map((p) => ({
        id: String(p),
        label: t(`priority.${p}` as "priority.0"),
        icon: <PriorityIcon priority={p} title="" />,
        checked: p === task.priority,
        apply: () => setPriority([task], p),
      })),
  },
  bulk: { place: "bar", icon: <PriorityIcon priority={2} title="" /> },
  timeline: [
    {
      field: "priority",
      say: (c) => {
        const p = Number(c.to) || 0;
        return p ? t("timeline.priority", { name: t(`priority.${p}` as "priority.1") }) : t("timeline.priorityCleared");
      },
    },
  ],
  filter: {
    word: "priority",
    title: () => t("filter.priority"),
    holds: "numbers",
    useOptions: () =>
      PRIORITIES.map((p) => ({
        id: String(p),
        label: tMaybe(`priority.${p}`),
        icon: <PriorityIcon priority={p} title="" />,
      })),
    matches: (task, picked) => picked.includes(String(task.priority)),
    read: (q) => (q.priority ?? []).filter((p) => PRIORITIES.includes(p)).map(String),
  },
} satisfies TaskProperty<"priority">;
