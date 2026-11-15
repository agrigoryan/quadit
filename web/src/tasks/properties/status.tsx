// A task's status: where it is in its project's workflow.

import { useMemo } from "react";
import { CircleDot } from "lucide-react";
import { t, tMaybe } from "@/lib/i18n";
import { getRowEvenIfGone, useRowEvenIfGone, useStatuses } from "@/lib/selectors";
import { useManageLinks } from "@/tasks/manage";
import { leaving, Pill, pill } from "@/tasks/properties/create-pill";
import { Picker } from "@/ui/picker";
import { setStatus } from "@/tasks/actions";
import { PickerRow } from "@/tasks/properties/panel-row";
import { asText, type CreateProps, type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { StatusIcon } from "@/ui/icons";
import { nameWord, rowsNamed } from "@/tasks/properties/query-words";

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

/** The project's default status until another is picked. */
function StatusPill({ project, value, onChange, onLeave }: CreateProps) {
  const manage = useManageLinks(project.id);
  const statuses = useStatuses(project.id);
  const s = statuses.find((x) => x.id === value.statusId) ?? statuses.find((x) => x.is_default) ?? statuses[0];
  return (
    <Picker
      label={t("prop.status")}
      placeholder={t("prop.set.status")}
      value={s?.id}
      items={statuses.map((x) => ({ id: x.id, label: x.name, icon: <StatusIcon category={x.category} /> }))}
      onPick={(id) => onChange({ statusId: id })}
      manage={leaving(manage.statuses, onLeave)}
    >
      <button type="button" className={pill} aria-label={`${t("prop.status")}: ${s?.name ?? ""}`}>
        <Pill icon={s && <StatusIcon category={s.category} />} set>
          {s?.name ?? t("prop.status")}
        </Pill>
      </button>
    </Picker>
  );
}

export const status = {
  name: "status",
  title: () => t("prop.status"),
  manage: "statuses",
  picker: {
    title: () => t("prop.set.status"),
    hotkey: { key: "s", shortcut: "shortcuts.status" },
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
  Create: StatusPill,
  palette: {
    icon: <CircleDot />,
    useChoices: (task) =>
      useStatuses(task.project_id).map((s) => ({
        id: s.id,
        label: s.name,
        words: tMaybe(`category.${s.category}`),
        icon: <StatusIcon category={s.category} />,
        checked: s.id === task.status_id,
        apply: () => setStatus([task], s.id),
      })),
  },
  bulk: { place: "bar", icon: <CircleDot className="size-3.5" aria-hidden /> },
  timeline: [
    {
      field: "status_id",
      say: (c) => {
        const to = getRowEvenIfGone("statuses", asText(c.to))?.name;
        const from = getRowEvenIfGone("statuses", asText(c.from))?.name;
        if (!to) return null;
        return from ? t("timeline.status", { from, to }) : t("timeline.statusTo", { to });
      },
    },
  ],
  filter: {
    word: "status",
    title: () => t("filter.status"),
    // A project's own: statuses differ from one project to the next.
    offered: (project) => !!project,
    useOptions: (project) => {
      const statuses = useStatuses(project?.id);
      return useMemo(
        () => statuses.map((s) => ({ id: s.id, label: s.name, icon: <StatusIcon category={s.category} /> })),
        [statuses],
      );
    },
    matches: (task, picked) => picked.includes(task.status_id),
    read: (q, ctx) => (q.status ?? []).flatMap((ref) => rowsNamed(ctx.c.statuses, ref, ctx)),
    address: (id, c, projectId) => nameWord(c.statuses, id, projectId),
    canBeGone: true,
  },
} satisfies TaskProperty<"status">;
