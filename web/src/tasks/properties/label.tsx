// A task's labels: any number of its project's (or the workspace's) labels.

import { Tag } from "lucide-react";
import { t } from "@/lib/i18n";
import { useLabels, useLookupEvenIfGone } from "@/lib/selectors";
import { toggleLabel } from "@/tasks/actions";
import { createLabel, createLabelText, useManageLinks } from "@/tasks/manage";
import { leaving, Pill, pill } from "@/tasks/properties/create-pill";
import { PickerRow } from "@/tasks/properties/panel-row";
import type { CreateProps, PanelProps, TaskProperty } from "@/tasks/properties/property";
import { LabelChip } from "@/ui/badge";
import { Picker } from "@/ui/picker";

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

function LabelPill({ project, value, onChange, onLeave }: CreateProps) {
  const manage = useManageLinks(project.id);
  const labels = useLabels(project.id);
  const picked = labels.filter((l) => value.labelIds.includes(l.id));
  return (
    <Picker
      multiple
      label={t("prop.labels")}
      placeholder={t("prop.set.labels")}
      value={value.labelIds}
      items={labels.map((l) => ({
        id: l.id,
        label: l.name,
        icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
      }))}
      onPick={(id) =>
        onChange({
          labelIds: value.labelIds.includes(id) ? value.labelIds.filter((v) => v !== id) : [...value.labelIds, id],
        })
      }
      onCreate={(name) => onChange({ labelIds: [...value.labelIds, createLabel(project.id, name)] })}
      createLabel={createLabelText}
      manage={leaving(manage.labels, onLeave)}
    >
      <button
        type="button"
        className={pill}
        aria-label={`${t("prop.labels")}: ${picked.map((l) => l.name).join(", ") || t("task.noLabels")}`}
      >
        <Pill icon={<Tag className="size-3.5" aria-hidden />} set={picked.length > 0}>
          {picked.length > 0 ? picked.map((l) => l.name).join(", ") : t("prop.labels")}
        </Pill>
      </button>
    </Picker>
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
  Create: LabelPill,
  bulk: { place: "bar", icon: <Tag className="size-3.5" aria-hidden /> },
} satisfies TaskProperty<"label">;
