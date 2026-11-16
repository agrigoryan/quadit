// The project a task is in. Changing it moves the task: a new key there.

import { FolderInput } from "lucide-react";
import { t } from "@/lib/i18n";
import { useProjects } from "@/data/selectors";
import { moveToProject } from "@/tasks/actions";
import { asText, shared, type TaskProperty } from "@/tasks/properties/property";
import { projectItems } from "@/tasks/property-picker";
import { ProjectGlyph } from "@/ui/project-glyph";

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
  palette: {
    title: () => t("prop.set.project"),
    icon: <FolderInput />,
    useChoices: (task) =>
      useProjects().map((p) => ({
        id: p.id,
        label: p.name,
        detail: p.key,
        icon: <ProjectGlyph project={p} />,
        checked: p.id === task.project_id,
        apply: () => moveToProject([task], p.id),
      })),
  },
  bulk: { place: "move", icon: <FolderInput />, label: () => t("bulk.move") },
  timeline: [
    {
      field: "project_id",
      say: (_c, { data }) => (data.moved_from ? t("timeline.movedProject", { key: asText(data.moved_from) }) : null),
    },
  ],
} satisfies TaskProperty<"project">;
