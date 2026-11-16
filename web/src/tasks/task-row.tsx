import { type CSSProperties, memo } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { useDecisionFlag, useLookup, useRow } from "@/data/selectors";
import { useIsDraft } from "@/data/store";
import { isClosedCategory, type Task } from "@/types/core";
import { useTaskLink } from "@/nav/task-link";
import type { Branch } from "@/tasks/list-layout";
import { AssigneeControl } from "@/tasks/assignee-control";
import { priority } from "@/tasks/properties/priority";
import { status as statusProperty } from "@/tasks/properties/status";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { DueChip, EpicChip, SubtaskPill, WaitsOnChip } from "@/tasks/task-chips";
import { LabelChip } from "@/ui/badge";
import { DecisionMark, PriorityIcon, StatusIcon } from "@/ui/icons";

/**
 * The key column is 4.25rem wide, which holds "SVA-9999". Where a list has
 * a longer key ("SVA-10012") the column is made to fit the longest: put
 * this style on the element that holds the rows. It is undefined when every
 * key fits as it is.
 */
export function keyColumn(keys: Iterable<string | undefined>): CSSProperties | undefined {
  let widest = 0;
  for (const key of keys) {
    if (!key || key.length <= 8) continue;
    // In ch, erring a little wide: the digits are tabular, M and W are the wide letters.
    let width = 0.2;
    for (const char of key)
      width += char >= "0" && char <= "9" ? 1.03 : /[mw]/i.test(char) ? 1.65 : /[a-z]/i.test(char) ? 1.2 : 1;
    widest = Math.max(widest, width);
  }
  return widest > 0 ? ({ "--key-col": `max(4.25rem, ${widest.toFixed(2)}ch)` } as CSSProperties) : undefined;
}

/** The key column of a row; see keyColumn. */
export const keyCell = "w-[var(--key-col,4.25rem)] shrink-0 truncate text-xs text-ink-3 tnum";

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
  /** Its place in a tree of sub-tasks (tasks/list-layout.ts): drawn indented, with the tree's lines; a context row cannot be selected. */
  branch?: Branch;
  /** Folds or unfolds the rows nested under this one; handed `at`. */
  onFold?: (at: string) => void;
}

const iconButton =
  "relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover data-[state=open]:bg-hover";

/**
 * One task as a dense line: key, title, and what matters about it right now.
 * The status, priority and assignee can be changed in place.
 */
export const TaskRow = memo(function TaskRow({
  task,
  focused,
  selected,
  onSelect,
  onHover,
  at,
  hide,
  branch,
  onFold,
}: Props) {
  const status = useRow("statuses", task.status_id);
  const epic = useRow("epics", task.epic_id);
  const labels = useLookup("labels");
  const decision = useDecisionFlag(task.id);
  const link = useTaskLink(task);
  // Just made here and not yet numbered by the server: there is no address to open it at.
  const draft = useIsDraft(task.id);
  const closed = isClosedCategory(status?.category);
  // The pickers stay shut on a task the viewer may not change (read-only, another project, the trash).
  const readOnly = !useCan().editTask(task);
  const context = branch?.context ?? false;

  return (
    <div
      data-task={task.id}
      data-focused={focused || undefined}
      role={branch && "listitem"}
      aria-level={branch && branch.depth + 1}
      aria-posinset={branch?.position}
      aria-setsize={branch?.siblings}
      onMouseMove={onHover && !focused ? () => onHover(task, at) : undefined}
      className={cx(
        "group relative flex h-9 items-center gap-1.5 border-b border-line/70 pr-3 pl-1.5 text-sm [contain-intrinsic-size:auto_36px] [content-visibility:auto]",
        selected ? "bg-accent-soft" : focused ? "bg-hover" : "bg-surface",
      )}
    >
      {focused && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      {onSelect && context && <span className="size-6 shrink-0" aria-hidden />}
      {onSelect && !context && (
        <button
          type="button"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a button drawn as a box; a native checkbox would need a hidden input and a label; Shift-click picks a range
          role="checkbox"
          aria-checked={!!selected}
          aria-label={t("list.select", { key: task.key })}
          onClick={(e) => onSelect(task, e.shiftKey, at)}
          className={cx(
            "relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-sm",
            selected
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-data-[focused]:opacity-100",
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

      {branch && <TreeGutter branch={branch} label={task.key} onFold={onFold && (() => onFold(at ?? task.id))} />}

      <TaskPropertyPicker property={priority} tasks={[task]}>
        <button
          type="button"
          className={iconButton}
          disabled={readOnly}
          aria-label={`${t("prop.priority")}: ${t(`priority.${task.priority}` as "priority.0")}`}
        >
          <PriorityIcon priority={task.priority} title="" />
        </button>
      </TaskPropertyPicker>

      <span className={cx(keyCell, "max-sm:hidden")}>{task.key}</span>

      {status && (
        <TaskPropertyPicker property={statusProperty} tasks={[task]}>
          <button
            type="button"
            className={iconButton}
            disabled={readOnly}
            aria-label={`${t("prop.status")}: ${status.name}`}
          >
            <StatusIcon category={status.category} />
          </button>
        </TaskPropertyPicker>
      )}

      {draft ? (
        <span aria-current={focused || undefined} className="min-w-0 truncate py-2 text-ink-2">
          {task.title}
        </span>
      ) : (
        <Link
          {...link}
          // J and K move a marker, not the page's focus: the row's link says it is the one they are on.
          aria-current={focused || undefined}
          aria-label={context ? t("list.openContext", { key: task.key }) : t("task.open", { key: task.key })}
          className={cx(
            "min-w-0 truncate py-2 outline-none after:absolute after:inset-0 after:content-['']",
            (closed || context) && "text-ink-2",
          )}
        >
          {task.title}
        </Link>
      )}

      {/* How far its sub-tasks have got reads with the title, not among the chips at the far end. Under the row-wide link: a click on it opens the task. */}
      <SubtaskPill taskId={task.id} className="ml-0.5" />
      <span className="flex-1" aria-hidden />

      {/* Everything at the right end sits above the row-wide link. */}
      <div className="relative z-[1] flex shrink-0 items-center gap-2">
        {decision && (
          <DecisionMark
            mine={decision === "mine"}
            title={decision === "mine" ? t("task.decisionYours") : t("task.decisionOpen")}
          />
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
        {!hide?.assignee && <AssigneeControl task={task} readOnly={readOnly} className={iconButton} />}
      </div>
    </div>
  );
});

/** How far one level of the tree indents, in pixels: the width of the fold control. */
const STEP = 16;

/**
 * The room left of a nested row: one column per level above it and one for
 * its own fold control. The tree's lines run through the middle of the
 * columns: an elbow from the parent's column into this row, and a line on
 * down wherever more rows of that level follow.
 */
function TreeGutter({ branch, label, onFold }: { branch: Branch; label: string; onFold?: () => void }) {
  const { depth, rails, children, folded } = branch;
  const mid = (level: number) => level * STEP + STEP / 2;
  const line = "absolute w-px bg-line-strong";
  return (
    <span className="relative -mb-px shrink-0 self-stretch" style={{ width: (depth + 1) * STEP }}>
      {rails.map((on, level) =>
        on ? <span key={level} className={cx(line, "inset-y-0")} style={{ left: mid(level) }} aria-hidden /> : null,
      )}
      {depth > 0 && (
        <span
          className="absolute top-0 h-1/2 rounded-bl-[5px] border-b border-l border-line-strong"
          style={{ left: mid(depth - 1), width: depth * STEP - mid(depth - 1) + (children > 0 ? 1 : STEP - 3) }}
          aria-hidden
        />
      )}
      {children > 0 && !folded && (
        <span className={cx(line, "top-[calc(50%+8px)] bottom-0")} style={{ left: mid(depth) }} aria-hidden />
      )}
      {children > 0 && (
        <button
          type="button"
          aria-expanded={!folded}
          aria-label={folded ? t("list.unfold", { key: label }) : t("list.fold", { key: label })}
          // A click folds and leaves the keyboard where it was: with the focus on the arrow, Space would go on folding instead of showing the row's task.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onFold}
          className="absolute top-1/2 z-[1] flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
          style={{ left: depth * STEP }}
        >
          <ChevronDown
            className={cx("size-3.5 transition-transform duration-100", folded && "-rotate-90")}
            aria-hidden
          />
        </button>
      )}
    </span>
  );
}
