// Who has the task: a person or an agent, or nobody.

import { t } from "@/lib/i18n";
import { useListening } from "@/lib/listening";
import { useMe, useMembers } from "@/lib/selectors";
import { setAssignee } from "@/tasks/actions";
import { NONE, shared, type TaskProperty } from "@/tasks/properties/property";
import { memberItems, noneItem } from "@/tasks/property-picker";

export const assignee = {
  name: "assignee",
  title: () => t("prop.assignee"),
  picker: {
    title: () => t("prop.set.assignee"),
    hotkey: "a",
    useItems: (tasks) => {
      const members = useMembers();
      const me = useMe();
      // Asked of the server only while the list is open.
      const listening = useListening();
      return {
        items: [noneItem(t("task.unassigned")), ...memberItems(members, me.user_id, listening)],
        value: shared(tasks, (task) => task.assignee_id ?? NONE),
      };
    },
    pick: (tasks, id) => setAssignee(tasks, id === NONE ? null : id),
  },
} satisfies TaskProperty<"assignee">;
