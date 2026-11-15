import { memo } from "react";
import { ChevronDown, Layers, Plus } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatNumber, t } from "@/lib/i18n";
import { useMember } from "@/lib/selectors";
import { useRestLoaded, useStore } from "@/lib/store";
import { isOpenCategory } from "@/lib/types";
import { RestLoadingNote } from "@/ui/rest-note";
import { NONE, type TaskGroup } from "@/tasks/filters";
import { Avatar } from "@/ui/avatar";
import { IconButton } from "@/ui/button";
import { PriorityIcon, StatusIcon } from "@/ui/icons";

/** The mark that goes with a group's name: a status quad, an avatar, a priority, a label's colour. */
export function GroupIcon({ group }: { group: TaskGroup }) {
  const member = useMember(group.kind === "assignee" && group.value !== NONE ? group.value : undefined);
  const color = useStore((s) => (group.kind === "label" ? s.collections.labels[group.value]?.color : undefined));
  if (group.kind === "label") {
    return (
      <span
        className="mx-0.5 size-2.5 shrink-0 rounded-full"
        style={{ background: group.value === NONE ? "var(--line-strong)" : color || "var(--ink-3)" }}
        aria-hidden
      />
    );
  }
  if (group.kind === "status" && group.category) return <StatusIcon category={group.category} />;
  if (group.kind === "assignee") return <Avatar member={member} size="xs" />;
  if (group.kind === "priority") return <PriorityIcon priority={Number(group.value)} title="" />;
  if (group.kind === "epic") return <Layers className="size-3.5 text-ink-3" aria-hidden />;
  return null;
}

/**
 * How many tasks a group holds. Finished work arrives after the rest, so
 * until it has, a Done or Canceled group says it is loading: a count then
 * would be wrong.
 */
export function GroupCount({
  group,
  count = group.tasks.length,
  className,
}: {
  group: TaskGroup;
  count?: number;
  className?: string;
}) {
  const loaded = useRestLoaded();
  if (!loaded && group.kind === "status" && !isOpenCategory(group.category))
    return <RestLoadingNote className={className} />;
  return <span className={cx("text-xs text-ink-3 tnum", className)}>{formatNumber(count)}</span>;
}

interface Props {
  group: TaskGroup;
  collapsed: boolean;
  onToggle: (group: TaskGroup) => void;
  /** Opens the create dialog with this group's value filled in. */
  onAdd?: (group: TaskGroup) => void;
}

/** The heading of a list section: fold it, see how many, add one. */
export const GroupHeader = memo(function GroupHeader({ group, collapsed, onToggle, onAdd }: Props) {
  return (
    <div className="sticky top-0 z-[2] flex h-8 items-center gap-1 border-b border-line bg-sunken pr-2 pl-1.5">
      <button
        type="button"
        onClick={() => onToggle(group)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("list.expand", { name: group.title }) : t("list.collapse", { name: group.title })}
        className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left"
      >
        <ChevronDown
          className={cx("size-3.5 shrink-0 text-ink-3 transition-transform duration-100", collapsed && "-rotate-90")}
          aria-hidden
        />
        <GroupIcon group={group} />
        <span className="truncate text-sm font-medium">{group.title}</span>
        <GroupCount group={group} />
      </button>
      {onAdd && (
        <IconButton size="sm" label={t("list.addTo", { name: group.title })} onClick={() => onAdd(group)}>
          <Plus className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
});
