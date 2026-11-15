// Who has the task: a person or an agent, or nobody.

import { UserRound } from "lucide-react";
import { t } from "@/lib/i18n";
import { useListening } from "@/lib/listening";
import { useMe, useMember, useMembers } from "@/lib/selectors";
import { setAssignee } from "@/tasks/actions";
import { orNone, Pill, pill } from "@/tasks/properties/create-pill";
import { PickerRow, PropRow } from "@/tasks/properties/panel-row";
import { type CreateProps, NONE, type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { memberItems, noneItem } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { Picker } from "@/ui/picker";
import { Tooltip } from "@/ui/tooltip";

/** Who has the task, and, for an agent, the person it works for. */
function AssigneeRow(panel: PanelProps) {
  const person = useMember(panel.task.assignee_id);
  const askedBy = useMember(panel.task.asked_by);
  const name = person ? person.name : t("task.unassigned");
  return (
    <>
      <PickerRow property={assignee} panel={panel} value={name} empty={!person}>
        <Avatar member={person} size="xs" />
        <span className="truncate">{name}</span>
      </PickerRow>
      {askedBy && person?.kind === "agent" && (
        <PropRow label={t("prop.workingFor")} wide>
          <Tooltip label={t("prop.workingForHint", { name: askedBy.name })}>
            <span
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so the keyboard can show the tooltip that says whom the agent works for
              tabIndex={0}
              className="flex h-7 min-w-0 max-w-full cursor-default items-center gap-1.5 rounded-md text-sm text-ink-2 max-md:h-9"
            >
              <Avatar member={askedBy} size="xs" />
              <span className="truncate">{askedBy.name}</span>
            </span>
          </Tooltip>
        </PropRow>
      )}
    </>
  );
}

function AssigneePill({ value, onChange }: CreateProps) {
  const members = useMembers();
  const me = useMe();
  const listening = useListening();
  const person = members.find((m) => m.user_id === value.assigneeId);
  return (
    <Picker
      label={t("prop.assignee")}
      placeholder={t("prop.set.assignee")}
      value={value.assigneeId || NONE}
      items={[noneItem(t("task.unassigned")), ...memberItems(members, me.user_id, listening)]}
      onPick={(id) => onChange({ assigneeId: orNone(id) })}
    >
      <button type="button" className={pill}>
        <Pill
          icon={person ? <Avatar member={person} size="xs" /> : <UserRound className="size-3.5" aria-hidden />}
          set={!!person}
        >
          {person?.name ?? t("prop.assignee")}
        </Pill>
      </button>
    </Picker>
  );
}

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
  Panel: AssigneeRow,
  Create: AssigneePill,
  bulk: { place: "bar", icon: <UserRound className="size-3.5" aria-hidden /> },
} satisfies TaskProperty<"assignee">;
