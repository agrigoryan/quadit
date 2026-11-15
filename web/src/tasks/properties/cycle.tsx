// The cycle (a project's run of days) a task is planned for, if any.

import { RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { useCycles } from "@/lib/selectors";
import { formatDay } from "@/lib/time";
import type { Cycle } from "@/lib/types";
import { setCycle } from "@/tasks/actions";
import { NONE, shared, type TaskProperty } from "@/tasks/properties/property";
import { noneItem } from "@/tasks/property-picker";

/** "Cycle 4", where it has no name of its own. */
export const cycleName = (c: Cycle) => c.name || t("prop.cycleName", { n: String(c.number) });

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
} satisfies TaskProperty<"cycle">;
