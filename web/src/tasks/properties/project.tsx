// The project a task is in. Changing it moves the task: a new key there.

import { t } from "@/lib/i18n";
import { useProjects } from "@/lib/selectors";
import { moveToProject } from "@/tasks/actions";
import { shared, type TaskProperty } from "@/tasks/properties/property";
import { projectItems } from "@/tasks/property-picker";

export const project = {
  name: "project",
  title: () => t("prop.project"),
  picker: {
    title: () => t("prop.set.project"),
    useItems: (tasks) => ({
      items: projectItems(useProjects()),
      value: shared(tasks, (task) => task.project_id),
    }),
    pick: moveToProject,
  },
} satisfies TaskProperty<"project">;
