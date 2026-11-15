import { memo } from "react";
import { Check } from "lucide-react";
import { Link, useLocation } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useDecisionFlag, useSubtaskProgress } from "@/lib/selectors";
import { useIsDraft, useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { AssigneeAvatar, DueChip, EpicChip, WaitsOnChip } from "@/tasks/task-chips";
import { LabelChip } from "@/ui/badge";
import { DecisionMark, PriorityIcon, StatusIcon } from "@/ui/icons";

/** Where a task opens: its panel, over whatever page is showing now. */
export function useTaskLink(task: Pick<Task, "key">) {
  const slug = useStore((s) => s.slug);
  const location = useLocation();
  // From inside a panel the page stays the one under it. A panel opened from a bare
  // link has no page under it; the shell then puts the task's own list there.
  const under = (location.state as { background?: unknown } | null)?.background;
  const background = under ?? (/\/task\/[^/]+\/?$/.test(location.pathname) ? undefined : location);
  return { to: `/${slug}/task/${task.key}`, state: background ? { background } : undefined };
}

interface Props {
  task: Task;
  /** The row the keyboard is on. */
  focused?: boolean;
  selected?: boolean;
  /** Shows a checkbox; leave out where rows cannot be selected. */
  onSelect?: (task: Task, range: boolean, at?: string) => void;
  onHover?: (task: Task, at?: string) => void;
  /** Which row this is, where a task can be listed more than once; handed back to onSelect and onHover. */
  at?: string;
  /** Hide the columns that the grouping already says. */
  hide?: { epic?: boolean; assignee?: boolean };
}

const iconButton = "relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover data-[state=open]:bg-hover";

/**
 * One task as a dense line: key, title, and what matters about it right now.
 * The status, priority and assignee can be changed in place.
 */
export const TaskRow = memo(function TaskRow({ task, focused, selected, onSelect, onHover, at, hide }: Props) {
  const status = useStore((s) => s.c.statuses[task.status_id]);
  const epic = useStore((s) => (task.epic_id ? s.c.epics[task.epic_id] : undefined));
  const labels = useStore((s) => s.c.labels);
  const decision = useDecisionFlag(task.id);
  const progress = useSubtaskProgress(task.id);
  const link = useTaskLink(task);
  // Just made here and not yet numbered by the server: there is no address to open it at.
  const draft = useIsDraft(task.id);
  const closed = status?.category === "done" || status?.category === "canceled";

  return (
    <div
      data-task={task.id}
      data-focused={focused || undefined}
      onMouseMove={onHover && !focused ? () => onHover(task, at) : undefined}
      className={cx(
        "group relative flex h-9 items-center gap-1.5 border-b border-line/70 pr-3 pl-1.5 text-sm [contain-intrinsic-size:auto_36px] [content-visibility:auto]",
        selected ? "bg-accent-soft" : focused ? "bg-hover" : "bg-surface",
      )}
    >
      {focused && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      {onSelect && (
        <button
          type="button"
          role="checkbox"
          aria-checked={!!selected}
          aria-label={t("list.select", { key: task.key })}
          onClick={(e) => onSelect(task, e.shiftKey, at)}
          className={cx(
            "relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-sm",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-data-[focused]:opacity-100",
          )}
        >
          <span
            className={cx(
              "flex size-3.5 items-center justify-center rounded-xs border",
              selected ? "border-accent bg-accent text-accent-ink" : "border-line-strong bg-surface",
            )}
          >
            {selected && <Check className="size-3" strokeWidth={3} aria-hidden />}
          </span>
        </button>
      )}

      <TaskPropertyPicker kind="priority" tasks={[task]}>
        <button type="button" className={iconButton} aria-label={`${t("prop.priority")}: ${t(`priority.${task.priority}` as "priority.0")}`}>
          <PriorityIcon priority={task.priority} title="" />
        </button>
      </TaskPropertyPicker>

      <span className="w-[4.25rem] shrink-0 truncate text-xs text-ink-3 tnum max-sm:hidden">{task.key}</span>

      {status && (
        <TaskPropertyPicker kind="status" tasks={[task]}>
          <button type="button" className={iconButton} aria-label={`${t("prop.status")}: ${status.name}`}>
            <StatusIcon category={status.category} />
          </button>
        </TaskPropertyPicker>
      )}

      {draft ? (
        <span className="min-w-0 flex-1 truncate py-2 text-ink-2">{task.title}</span>
      ) : (
        <Link
          {...link}
          aria-label={t("task.open", { key: task.key })}
          className={cx("min-w-0 flex-1 truncate py-2 outline-none after:absolute after:inset-0 after:content-['']", closed && "text-ink-2")}
        >
          {task.title}
        </Link>
      )}

      {/* Everything right of the title sits above the row-wide link. */}
      <div className="relative z-[1] flex shrink-0 items-center gap-2">
        {progress && <span className="text-xs text-ink-3 tnum max-md:hidden">{progress}</span>}
        {decision && (
          <DecisionMark mine={decision === "mine"} title={decision === "mine" ? t("task.decisionYours") : t("task.decisionOpen")} />
        )}
        <WaitsOnChip task={task} className="max-sm:max-w-28" />
        <span className="flex items-center gap-1 max-lg:hidden">
          {task.label_ids?.slice(0, 3).map((id) => {
            const label = labels[id];
            return label ? <LabelChip key={id} name={label.name} color={label.color} /> : null;
          })}
        </span>
        {!hide?.epic && epic && <EpicChip name={epic.name} className="max-xl:hidden" />}
        {task.due_on && <DueChip day={task.due_on} done={closed} className="max-sm:hidden" />}
        {!hide?.assignee && (
          <TaskPropertyPicker kind="assignee" tasks={[task]} align="end">
            <button type="button" className={iconButton} aria-label={t("prop.assignee")}>
              <AssigneeAvatar userId={task.assignee_id} />
            </button>
          </TaskPropertyPicker>
        )}
      </div>
    </div>
  );
});
