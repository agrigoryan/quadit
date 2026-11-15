// A task's labels: any number of its project's (or the workspace's) labels.

import { useMemo } from "react";
import { Tag } from "lucide-react";
import { joinPhrases, t } from "@/lib/i18n";
import { getRowEvenIfGone, useLabels, useLookupEvenIfGone, useRow } from "@/lib/selectors";
import { toggleLabel } from "@/tasks/actions";
import { createLabel, createLabelText, useManageLinks } from "@/tasks/manage";
import { leaving, Pill, pill } from "@/tasks/properties/create-pill";
import { PickerRow } from "@/tasks/properties/panel-row";
import {
  asIds,
  type CreateProps,
  type GroupHead,
  NONE,
  type PanelProps,
  type TaskProperty,
} from "@/tasks/properties/property";
import { nameWord, rowsNamed } from "@/tasks/properties/query-words";
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

/** A group's dot, in its label's colour. */
function LabelMark({ group }: { group: GroupHead }) {
  const color = useRow("labels", group.value !== NONE ? group.value : undefined)?.color;
  return (
    <span
      className="mx-0.5 size-2.5 shrink-0 rounded-full"
      style={{ background: group.value === NONE ? "var(--line-strong)" : color || "var(--ink-3)" }}
      aria-hidden
    />
  );
}

export const label = {
  name: "label",
  title: () => t("prop.labels"),
  make: { run: createLabel, label: createLabelText },
  manage: "labels",
  picker: {
    title: () => t("prop.set.labels"),
    hotkey: { key: "l", shortcut: "shortcuts.labels" },
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
  palette: {
    icon: <Tag />,
    useChoices: (task) =>
      useLabels(task.project_id).map((l) => ({
        id: l.id,
        label: l.name,
        icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
        checked: task.label_ids?.includes(l.id) ?? false,
        apply: () => toggleLabel([task], l.id),
      })),
    empty: () => t("palette.noLabels"),
  },
  bulk: { place: "bar", icon: <Tag className="size-3.5" aria-hidden /> },
  timeline: [
    {
      field: "label_ids",
      say: (c) => {
        const before = asIds(c.from);
        const after = asIds(c.to);
        const names = (list: string[]) =>
          list.map((id) => getRowEvenIfGone("labels", id)?.name).filter((n): n is string => !!n);
        const added = names(after.filter((id) => !before.includes(id)));
        const removed = names(before.filter((id) => !after.includes(id)));
        const out: string[] = [];
        if (added.length) out.push(t("timeline.labelAdded", { n: added.length, names: joinPhrases(added) }));
        if (removed.length) out.push(t("timeline.labelRemoved", { n: removed.length, names: joinPhrases(removed) }));
        return out;
      },
    },
  ],
  filter: {
    word: "label",
    title: () => t("filter.label"),
    useOptions: (project) => {
      const labels = useLabels(project?.id);
      return useMemo(
        () =>
          labels.map((l) => ({
            id: l.id,
            label: l.name,
            icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
          })),
        [labels],
      );
    },
    // Any one of them.
    matches: (task, picked) => picked.some((id) => task.label_ids?.includes(id)),
    read: (q, ctx) => (q.label ?? []).flatMap((ref) => rowsNamed(ctx.c.labels, ref, ctx)),
    address: (id, c, projectId) => nameWord(c.labels, id, projectId),
    canBeGone: true,
  },
  group: {
    title: () => t("group.label"),
    groups: (c, projectId) => [
      ...Object.values(c.labels)
        .filter((l) => !l.project_id || !projectId || l.project_id === projectId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((l) => ({ id: l.id, title: l.name, value: l.id })),
      { id: NONE, title: t("task.noLabel"), value: NONE },
    ],
    // In each of its labels' groups; in "No label" when it has none of them.
    place: (task, _c, has) => {
      const ids = (task.label_ids ?? []).filter(has);
      return ids.length ? ids : [NONE];
    },
    Icon: LabelMark,
    draft: (group) => (group.value !== NONE ? { labelIds: [group.value] } : {}),
  },
} satisfies TaskProperty<"label">;
