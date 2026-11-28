// Who has the task: a person or an agent, or nobody.

import { useMemo } from "react";
import { CircleSlash, UserRound } from "lucide-react";
import { t } from "@/lib/i18n";
import { mayBeGivenWork } from "@/data/access";
import { useConnection, useListening } from "@/data/listening";
import { useMe, useMember, useMembers } from "@/data/selectors";
import type { Member, Task } from "@/types/core";
import { who } from "@/detail/data";
import { setAssignee } from "@/tasks/actions";
import { orNone, Pill, pill } from "@/tasks/properties/create-pill";
import { PickerRow, PropRow } from "@/tasks/properties/panel-row";
import {
  asText,
  type Choice,
  type CreateProps,
  type GroupHead,
  NONE,
  type PanelProps,
  shared,
  type TaskProperty,
} from "@/tasks/properties/property";
import { memberOf, memberWord } from "@/tasks/properties/query-words";
import { memberFilterItems, memberItems, noneItem, useAssignOutlook, useListeningFor } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { ConnectionMark } from "@/ui/connection-mark";
import { ListeningDot } from "@/ui/listening-dot";
import { Picker } from "@/ui/picker";
import { Tooltip } from "@/ui/tooltip";

/** Who has the task, and, for an agent, the person it works for. */
function AssigneeRow(panel: PanelProps) {
  const person = useMember(panel.task.assignee_id);
  const askedBy = useMember(panel.task.asked_by);
  const name = person ? person.name : t("task.unassigned");
  return (
    <>
      <PickerRow
        property={assignee}
        panel={panel}
        value={name}
        empty={!person}
        after={person?.kind === "agent" && <AgentConnection agent={person} project={panel.task.project_id} />}
      >
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

/** How far an agent assignee is connected: whether what is written on the task (in `project`) reaches it. */
function AgentConnection({ agent, project }: { agent: Member; project: string }) {
  const reach = useConnection()(agent, project);
  return reach ? <ConnectionMark connection={reach.connection} /> : null;
}

function AssigneePill({ project, value, onChange }: CreateProps) {
  const members = useMembers().filter((m) => mayBeGivenWork(m, project.id));
  const me = useMe();
  const listening = useListening(project.id);
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

/**
 * Unassigned, then me, then everyone else with their handle; a suspended
 * member, or one who may not read the task's project, only while it has
 * the task.
 */
function useChoices(task: Task): Choice[] {
  const members = useMembers();
  const me = useMe();
  const listening = useListening(task.project_id);
  return [
    {
      id: "nobody",
      label: t("task.unassigned"),
      icon: <CircleSlash className="text-ink-3" />,
      checked: !task.assignee_id,
      apply: () => setAssignee([task], null),
    },
    ...[...members]
      .filter((m) => m.user_id === task.assignee_id || (!m.suspended_at && mayBeGivenWork(m, task.project_id)))
      .sort((a, b) => Number(b.user_id === me.user_id) - Number(a.user_id === me.user_id))
      .map((m) => ({
        id: m.user_id,
        label: m.name,
        detail: `@${m.handle}`,
        mark:
          listening(m) === undefined ? undefined : (
            <ListeningDot on={listening(m) === true} className="ml-1.5 align-middle" />
          ),
        icon: <Avatar member={m} size="xs" />,
        checked: m.user_id === task.assignee_id,
        apply: () => setAssignee([task], m.user_id),
      })),
  ];
}

/** A group's avatar: the person's, or the empty one for "Unassigned". */
function AssigneeMark({ group }: { group: GroupHead }) {
  const person = useMember(group.value !== NONE ? group.value : undefined);
  return <Avatar member={person} size="xs" />;
}

export const assignee = {
  name: "assignee",
  title: () => t("prop.assignee"),
  key: { key: "a", shortcut: "shortcuts.assignee" },
  picker: {
    title: () => t("prop.set.assignee"),
    useItems: (tasks) => {
      // Those who may read every task's project: the server gives no one
      // work they cannot see.
      const members = useMembers().filter((m) => tasks.every((task) => mayBeGivenWork(m, task.project_id)));
      const me = useMe();
      // Asked of the server only while the list is open; of the tasks' project when they share one.
      const listening = useListeningFor(tasks);
      // And what assigning one task would do for each agent a computer runs.
      const outlook = useAssignOutlook(tasks);
      return {
        items: [noneItem(t("task.unassigned")), ...memberItems(members, me.user_id, listening, outlook)],
        value: shared(tasks, (task) => task.assignee_id ?? NONE),
      };
    },
    pick: (tasks, id) => setAssignee(tasks, id === NONE ? null : id),
  },
  Panel: AssigneeRow,
  Create: AssigneePill,
  palette: { title: () => t("prop.set.assignee"), icon: <UserRound />, useChoices },
  bulk: { place: "bar", icon: <UserRound className="size-3.5" aria-hidden /> },
  timeline: [
    {
      field: "assignee_id",
      say: (c, { actorId }) => {
        if (!c.to) return t("timeline.unassigned");
        return c.to === actorId ? t("timeline.took") : t("timeline.assigned", { name: who(asText(c.to)) });
      },
    },
  ],
  filter: {
    word: "assignee",
    title: () => t("filter.assignee"),
    // Me first and "unassigned" last, as the wait's filter has them; the picker that assigns keeps its own order.
    useOptions: (_project, picked) => {
      const members = useMembers();
      const me = useMe();
      return useMemo(
        () => [...memberFilterItems(members, me.user_id, picked), noneItem(t("task.unassigned"))],
        [members, me.user_id, picked],
      );
    },
    matches: (task, picked) => picked.includes(task.assignee_id ?? NONE),
    read: (q, ctx) => (q.assignee ?? []).map((ref) => memberOf(ref, ctx)).filter((id) => id !== undefined),
    address: (id, c) => memberWord(id, c),
    canBeGone: true,
  },
  group: {
    title: () => t("group.assignee"),
    groups: (c) => [
      ...Object.values(c.members)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "person" ? -1 : 1))
        .map((m) => ({ id: m.user_id, title: m.name, value: m.user_id, quiet: !!(m.removed_at || m.suspended_at) })),
      { id: NONE, title: t("task.unassigned"), value: NONE },
    ],
    place: (task, _c, has) => {
      const id = task.assignee_id ?? NONE;
      return [has(id) ? id : NONE];
    },
    Icon: AssigneeMark,
    draft: (group) => (group.value !== NONE ? { assigneeId: group.value } : {}),
    hides: { assignee: true },
  },
} satisfies TaskProperty<"assignee">;
