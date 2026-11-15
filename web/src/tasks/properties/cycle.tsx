// The cycle (a project's run of days) a task is planned for, if any.

import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { getRowEvenIfGone, useCycles, useRowEvenIfGone } from "@/data/selectors";
import { formatDay, serverDay } from "@/lib/time";
import type { Cycle } from "@/types/core";
import { setCycle } from "@/tasks/actions";
import { PickerRow } from "@/tasks/properties/panel-row";
import {
  asText,
  NONE,
  type PanelProps,
  type QueryContext,
  shared,
  type TaskProperty,
} from "@/tasks/properties/property";
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

/**
 * The cycles a query's word names: by number or id, "current" for the one
 * running today and "next" for the one after. On a day with none running
 * (or none to come) the word itself stays as the filter: no task is in
 * "current", so none is shown, as the server answers too. Dropping it would
 * show every task.
 */
function cyclesNamed(ref: string, { c, inScope }: QueryContext): string[] {
  if (ref === NONE) return [NONE];
  const rows = Object.values(c.cycles)
    .filter((cy) => inScope(cy.project_id))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const orWord = (ids: string[]) => (ids.length ? ids : [ref]);
  const day = serverDay(); // a cycle's days are the server's, not this browser's
  if (ref === "current")
    return orWord(rows.filter((cy) => cy.starts_on <= day && day <= cy.ends_on).map((cy) => cy.id));
  if (ref === "next")
    return orWord(
      rows
        .filter((cy) => cy.starts_on > day)
        .slice(0, 1)
        .map((cy) => cy.id),
    );
  return rows.filter((cy) => cy.id === ref || String(cy.number) === ref).map((cy) => cy.id);
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
  filter: {
    word: "cycle",
    title: () => t("filter.cycle"),
    offered: (project) => !!project?.settings?.cycles,
    useOptions: (project) => {
      const cycles = useCycles(project?.id);
      return useMemo(
        () => [
          noneItem(t("task.noCycle")),
          ...cycles.map((c) => ({
            id: c.id,
            label: cycleName(c),
            icon: <RefreshCw className="size-3.5 text-ink-2" aria-hidden />,
          })),
        ],
        [cycles],
      );
    },
    matches: (task, picked) => picked.includes(task.cycle_id ?? NONE),
    read: (q, ctx) => (q.cycle ?? []).flatMap((ref) => cyclesNamed(ref, ctx)),
    canBeGone: true,
  },
} satisfies TaskProperty<"cycle">;
