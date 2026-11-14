import type { ReactNode } from "react";
import { CircleSlash } from "lucide-react";
import { t, tMaybe } from "@/lib/i18n";
import { useLabels, useMe, useMembers, useStatuses } from "@/lib/selectors";
import type { Task } from "@/lib/types";
import { Group, Item, Note } from "@/palette/palette-parts";
import type { ChoicePage } from "@/palette/palette-root";
import { matches } from "@/palette/palette-search";
import { setAssignee, setPriority, setStatus, toggleLabel } from "@/tasks/actions";
import { Avatar } from "@/ui/avatar";
import { PriorityIcon, StatusIcon } from "@/ui/icons";

interface Choice {
  id: string;
  label: string;
  /** More words the search should match. */
  words?: string;
  detail?: string;
  icon: ReactNode;
  checked: boolean;
  apply: () => void;
}

/** Urgent first, "no priority" last. */
const PRIORITIES = [1, 2, 3, 4, 0];

export const choiceTitle: Record<ChoicePage, () => string> = {
  status: () => t("prop.set.status"),
  assignee: () => t("prop.set.assignee"),
  priority: () => t("prop.set.priority"),
  labels: () => t("prop.set.labels"),
};

function useChoices(page: ChoicePage, task: Task): Choice[] {
  const statuses = useStatuses(task.project_id);
  const members = useMembers();
  const labels = useLabels(task.project_id);
  const me = useMe();

  switch (page) {
    case "status":
      return statuses.map((s) => ({
        id: s.id,
        label: s.name,
        words: tMaybe(`category.${s.category}`),
        icon: <StatusIcon category={s.category} />,
        checked: s.id === task.status_id,
        apply: () => setStatus([task], s.id),
      }));
    case "assignee":
      return [
        {
          id: "nobody",
          label: t("task.unassigned"),
          icon: <CircleSlash className="text-ink-3" />,
          checked: !task.assignee_id,
          apply: () => setAssignee([task], null),
        },
        ...[...members]
          .filter((m) => !m.suspended_at || m.user_id === task.assignee_id)
          .sort((a, b) => Number(b.user_id === me.user_id) - Number(a.user_id === me.user_id))
          .map((m) => ({
            id: m.user_id,
            label: m.name,
            detail: `@${m.handle}`,
            icon: <Avatar member={m} size="xs" />,
            checked: m.user_id === task.assignee_id,
            apply: () => setAssignee([task], m.user_id),
          })),
      ];
    case "priority":
      return PRIORITIES.map((p) => ({
        id: String(p),
        label: t(`priority.${p}` as "priority.0"),
        icon: <PriorityIcon priority={p} title="" />,
        checked: p === task.priority,
        apply: () => setPriority([task], p),
      }));
    case "labels":
      return labels.map((l) => ({
        id: l.id,
        label: l.name,
        icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
        checked: task.label_ids?.includes(l.id) ?? false,
        apply: () => toggleLabel([task], l.id),
      }));
  }
}

interface Props {
  page: ChoicePage;
  task: Task;
  query: string;
  /** Runs the choice and closes the palette. */
  run: (action: () => void) => void;
}

/** The palette's second page: the values one property of the open task can take. */
export function ChoicesPage({ page, task, query, run }: Props) {
  const choices = useChoices(page, task);
  const q = query.trim();
  const shown = q ? choices.filter((c) => matches(q, `${c.label} ${c.detail ?? ""} ${c.words ?? ""}`)) : choices;

  if (choices.length === 0 && page === "labels") return <Note>{t("palette.noLabels")}</Note>;
  if (shown.length === 0) return <Note>{t("common.noMatches")}</Note>;

  return (
    <Group>
      {shown.map((c) => (
        <Item key={c.id} value={`${page}:${c.id}`} icon={c.icon} detail={c.detail} checked={c.checked} onSelect={() => run(c.apply)}>
          {c.label}
        </Item>
      ))}
    </Group>
  );
}
