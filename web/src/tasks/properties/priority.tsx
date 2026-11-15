// How urgent a task is: 1 (urgent) to 4 (low), or 0 for none.

import { t } from "@/lib/i18n";
import { setPriority } from "@/tasks/actions";
import { shared, type TaskProperty } from "@/tasks/properties/property";
import { PriorityIcon } from "@/ui/icons";

/** Every priority, "no priority" first. */
export const PRIORITIES = [0, 1, 2, 3, 4];

export const priority = {
  name: "priority",
  title: () => t("prop.priority"),
  picker: {
    title: () => t("prop.set.priority"),
    hotkey: "p",
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
} satisfies TaskProperty<"priority">;
