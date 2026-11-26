import { memo } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatNumber, t } from "@/lib/i18n";
import { useRestLoaded } from "@/data/store";
import { isOpenCategory, type Project, type Task } from "@/types/core";
import { RestLoadingNote } from "@/ui/rest-note";
import { pointsOf } from "@/tasks/estimates";
import type { TaskGroup } from "@/tasks/filters";
import { GROUPINGS } from "@/tasks/properties";
import { IconButton } from "@/ui/button";
import { Tooltip } from "@/ui/tooltip";

/** The mark that goes with a group's name, as its property draws it: a status quad, an avatar, a priority, a label's colour. */
export function GroupIcon({ group }: { group: TaskGroup }) {
  const Icon = GROUPINGS.find((p) => p.name === group.kind)?.group.Icon;
  return Icon ? <Icon group={group} /> : null;
}

/**
 * How many tasks a group holds. Where the project in view estimates, its
 * points too, told on hover or focus ("12 tasks, 34 points"), which is also
 * what it is called. Finished work arrives after the rest, so until it has,
 * a Done or Canceled group says it is loading: a count then would be wrong.
 */
export function GroupCount({
  group,
  tasks = group.tasks,
  project,
  className,
}: {
  group: TaskGroup;
  /** The tasks it shows, where they are not the group's (a board's column while a card is dragged over it). */
  tasks?: Task[];
  /** The project in view, if there is one. */
  project: Project | undefined;
  className?: string;
}) {
  const loaded = useRestLoaded();
  if (!loaded && group.kind === "status" && !isOpenCategory(group.category))
    return <RestLoadingNote className={className} />;
  if (!project?.settings?.estimates)
    return <span className={cx("text-xs text-ink-3 tnum", className)}>{formatNumber(tasks.length)}</span>;
  const points = tasks.reduce((sum, task) => sum + pointsOf(task, project), 0);
  const totals = t("list.totals", {
    tasks: t("list.taskCount", { n: tasks.length }),
    points: t("prop.points", { n: points }),
  });
  return (
    <Tooltip label={totals} side="top">
      <span
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the count can be stepped to with Tab, to read its points in the tooltip
        tabIndex={0}
        aria-label={totals}
        className={cx("relative z-[1] rounded-sm text-xs text-ink-3 tnum outline-offset-2", className)}
      >
        {formatNumber(tasks.length)}
      </span>
    </Tooltip>
  );
}

interface Props {
  group: TaskGroup;
  /** The project in view, if there is one: where it estimates, the count tells the points too. */
  project: Project | undefined;
  collapsed: boolean;
  onToggle: (group: TaskGroup) => void;
  /** Opens the create dialog with this group's value filled in. */
  onAdd?: (group: TaskGroup) => void;
}

/**
 * The heading of a list section: fold it, see how many, add one. The fold
 * button is stretched over the whole heading; the count and the add button
 * sit above it, so the count can be hovered and focused on its own.
 */
export const GroupHeader = memo(function GroupHeader({ group, project, collapsed, onToggle, onAdd }: Props) {
  return (
    <div className="sticky top-0 z-[2] flex h-8 items-center gap-2 border-b border-line bg-sunken pr-2 pl-1.5">
      <button
        type="button"
        onClick={() => onToggle(group)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("list.expand", { name: group.title }) : t("list.collapse", { name: group.title })}
        className="flex h-6 min-w-0 items-center gap-2 rounded-sm px-1 text-left after:absolute after:inset-0 after:content-['']"
      >
        <ChevronDown
          className={cx("size-3.5 shrink-0 text-ink-3 transition-transform duration-100", collapsed && "-rotate-90")}
          aria-hidden
        />
        <GroupIcon group={group} />
        <span className="truncate text-sm font-medium">{group.title}</span>
      </button>
      <GroupCount group={group} project={project} />
      <span className="flex-1" aria-hidden />
      {onAdd && (
        <span className="relative z-[1]">
          <IconButton size="sm" label={t("list.addTo", { name: group.title })} onClick={() => onAdd(group)}>
            <Plus className="size-3.5" />
          </IconButton>
        </span>
      )}
    </div>
  );
});
