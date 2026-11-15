import { useMemo } from "react";
import { CircleSlash, Globe, Layers, RefreshCw } from "lucide-react";
import { t, tMaybe, type Key } from "@/lib/i18n";
import { useCycles, useEpics, useLabels, useMe, useMembers, useStatuses } from "@/lib/selectors";
import { CATEGORIES, type Project } from "@/lib/types";
import { type ListFilterKey, NONE, OUTSIDE } from "@/tasks/filters";
import { memberItems, PRIORITIES } from "@/tasks/property-picker";
import { PriorityIcon, StatusIcon } from "@/ui/icons";
import type { PickerItem } from "@/ui/picker";

export type FilterKind = ListFilterKey | "waitingOn" | "openDecision";

export const FILTER_LABEL: Record<FilterKind, Key> = {
  assignee: "filter.assignee",
  status: "filter.status",
  category: "filter.category",
  label: "filter.label",
  priority: "filter.priority",
  epic: "filter.epic",
  cycle: "filter.cycle",
  waitingOn: "filter.waitingOn",
  openDecision: "filter.openDecision",
};

const none = (label: string): PickerItem => ({ id: NONE, label, icon: <CircleSlash className="size-3.5 text-ink-3" aria-hidden /> });

/** What each filter can be set to, for the project in view (or the whole workspace). */
export function useFilterOptions(project: Project | undefined): Record<Exclude<FilterKind, "openDecision">, PickerItem[]> {
  const members = useMembers();
  const me = useMe();
  const statuses = useStatuses(project?.id);
  const labels = useLabels(project?.id);
  const epics = useEpics(project?.id);
  const cycles = useCycles(project?.id);

  return useMemo(() => {
    const people = memberItems(members, me.user_id);
    return {
      assignee: [none(t("task.unassigned")), ...people],
      waitingOn: [
        ...people,
        { id: OUTSIDE, label: t("prop.outside"), icon: <Globe className="size-3.5 text-ink-2" aria-hidden />, keywords: t("prop.outside.words") },
        none(t("prop.nobody")),
      ],
      status: statuses.map((s) => ({ id: s.id, label: s.name, icon: <StatusIcon category={s.category} /> })),
      category: CATEGORIES.map((cat) => ({ id: cat, label: tMaybe(`category.${cat}`), icon: <StatusIcon category={cat} /> })),
      label: labels.map((l) => ({
        id: l.id,
        label: l.name,
        icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
      })),
      priority: PRIORITIES.map((p) => ({ id: String(p), label: tMaybe(`priority.${p}`), icon: <PriorityIcon priority={p} title="" /> })),
      epic: [none(t("task.noEpic")), ...epics.map((e) => ({ id: e.id, label: e.name, icon: <Layers className="size-3.5 text-ink-2" aria-hidden /> }))],
      cycle: [
        none(t("task.noCycle")),
        ...cycles.map((cy) => ({
          id: cy.id,
          label: cy.name || t("prop.cycleName", { n: String(cy.number) }),
          icon: <RefreshCw className="size-3.5 text-ink-2" aria-hidden />,
        })),
      ],
    };
  }, [members, me.user_id, statuses, labels, epics, cycles]);
}
