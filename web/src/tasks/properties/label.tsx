// A task's labels: any number of its project's (or the workspace's) labels.

import { t } from "@/lib/i18n";
import { useLabels } from "@/lib/selectors";
import { toggleLabel } from "@/tasks/actions";
import { createLabel, createLabelText } from "@/tasks/manage";
import type { TaskProperty } from "@/tasks/properties/property";

export const label = {
  name: "label",
  title: () => t("prop.labels"),
  make: { run: createLabel, label: createLabelText },
  manage: "labels",
  picker: {
    title: () => t("prop.set.labels"),
    hotkey: "l",
    multiple: true,
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
} satisfies TaskProperty<"label">;
