// A task's status: where it is in its project's workflow.

import { t, tMaybe } from "@/lib/i18n";
import { useStatuses } from "@/lib/selectors";
import { setStatus } from "@/tasks/actions";
import { shared, type TaskProperty } from "@/tasks/properties/property";
import { StatusIcon } from "@/ui/icons";

export const status = {
  name: "status",
  title: () => t("prop.status"),
  manage: "statuses",
  picker: {
    title: () => t("prop.set.status"),
    hotkey: "s",
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
} satisfies TaskProperty<"status">;
