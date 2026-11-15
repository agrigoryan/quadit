// The milestone of its epic a task counts towards, if any.

import { Target } from "lucide-react";
import { t } from "@/lib/i18n";
import { useEpics, useRows } from "@/lib/selectors";
import { formatDay } from "@/lib/time";
import { setMilestone } from "@/tasks/actions";
import { NONE, shared, type TaskProperty } from "@/tasks/properties/property";
import { noneItem } from "@/tasks/property-picker";

export const milestone = {
  name: "milestone",
  title: () => t("prop.milestone"),
  picker: {
    title: () => t("prop.set.milestone"),
    useItems: (tasks) => {
      const first = tasks[0];
      const epics = useEpics(first?.project_id);
      const milestones = useRows("milestones");
      return {
        items: [
          noneItem(t("task.noMilestone")),
          ...milestones
            .filter((m) => (!first?.epic_id || m.epic_id === first.epic_id) && epics.some((e) => e.id === m.epic_id))
            .map((m) => ({
              id: m.id,
              label: m.name,
              icon: <Target className="size-3.5 text-ink-2" aria-hidden />,
              hint: m.target_on ? formatDay(m.target_on) : undefined,
            })),
        ],
        value: shared(tasks, (task) => task.milestone_id ?? NONE),
      };
    },
    pick: (tasks, id) => setMilestone(tasks, id === NONE ? null : id),
  },
} satisfies TaskProperty<"milestone">;
