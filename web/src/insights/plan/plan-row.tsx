// An epic or a cycle as a row of the epics or cycles page: it links to the
// full page of the epic or cycle, shows how far along it is, and opens in
// place to show its tasks.

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useRestLoaded } from "@/lib/store";
import type { Task } from "@/types/core";
import { emptyTally, type Tally } from "@/insights/plan/stats";
import { ProgressCount } from "@/insights/ui/progress";
import { RestLoadingNote } from "@/ui/rest-note";
import { keyColumn, TaskRow } from "@/tasks/task-row";

interface Props {
  name: string;
  /** Where the name leads: the epic's or cycle's own page. */
  to: string;
  /** Shown right after the name: a state, "Current", an at-risk mark. */
  badge?: ReactNode;
  /** Shown at the right, before the progress: dates, the lead. */
  meta?: ReactNode;
  /** Shown last: a menu of what can be done with the row. */
  menu?: ReactNode;
  tally: Tally | undefined;
  tasks: Task[];
  open: boolean;
  onToggle: () => void;
  /** What to say, opened, when it has no tasks. */
  emptyText: string;
  hide?: { epic?: boolean };
}

/** An epic or a cycle as one dense line; the arrow shows its tasks underneath. */
export function PlanRow({
  name,
  to,
  badge,
  meta,
  menu,
  tally = emptyTally(),
  tasks,
  open,
  onToggle,
  emptyText,
  hide,
}: Props) {
  const restLoaded = useRestLoaded();
  return (
    <li>
      <div className="flex h-9 items-center gap-2 border-b border-line/70 pr-2 pl-2 text-sm hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? "list.collapse" : "list.expand", { name })}
          onClick={onToggle}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-press"
        >
          <ChevronRight
            className={cx("size-4 text-ink-3 transition-transform duration-100", open && "rotate-90")}
            aria-hidden
          />
        </button>
        <Link to={to} className="min-w-0 truncate font-medium underline-offset-2 hover:underline">
          {name}
        </Link>
        {badge}
        <span className="flex-1" />
        {meta}
        {/* Finished tasks arrive after the rest; a count without them would be wrong. */}
        {restLoaded ? (
          <ProgressCount done={tally.done} started={tally.started} total={tally.total} />
        ) : (
          <RestLoadingNote className="shrink-0" />
        )}
        {menu}
      </div>
      {open && (
        <div className="border-b border-line bg-surface pl-5" style={keyColumn(tasks.map((task) => task.key))}>
          {tasks.length === 0 ? (
            <p className="px-2 py-2 text-xs text-ink-3">{emptyText}</p>
          ) : (
            tasks.map((task) => <TaskRow key={task.id} task={task} hide={hide} />)
          )}
        </div>
      )}
    </li>
  );
}
