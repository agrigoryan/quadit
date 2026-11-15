// The epic a task is part of, if any.

import { Layers } from "lucide-react";
import { t } from "@/lib/i18n";
import { useEpics } from "@/lib/selectors";
import { setEpic } from "@/tasks/actions";
import { NONE, shared, type TaskProperty } from "@/tasks/properties/property";
import { noneItem } from "@/tasks/property-picker";

export const epic = {
  name: "epic",
  title: () => t("prop.epic"),
  picker: {
    title: () => t("prop.set.epic"),
    useItems: (tasks) => ({
      items: [
        noneItem(t("task.noEpic")),
        ...useEpics(tasks[0]?.project_id).map((e) => ({
          id: e.id,
          label: e.name,
          icon: <Layers className="size-3.5 text-ink-2" aria-hidden />,
        })),
      ],
      value: shared(tasks, (task) => task.epic_id ?? NONE),
    }),
    pick: (tasks, id) => setEpic(tasks, id === NONE ? null : id),
  },
} satisfies TaskProperty<"epic">;
