// What the epics page and the cycles page share: a row that opens in place
// to show its tasks, and a small meter of how many of them are done.

import { type ReactNode, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCollection, useLiveTasks } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import { CATEGORIES, type Status, type Task } from "@/lib/types";
import { TaskRow } from "@/tasks/task-row";

/** A project's live tasks by the epic or cycle they are in, in status order. */
export function useTasksBy(projectId: string, field: "epic_id" | "cycle_id"): Dict<Task[]> {
  const tasks = useLiveTasks();
  const statuses = useCollection("statuses");
  return useMemo(() => {
    const out: Dict<Task[]> = {};
    for (const task of tasks) {
      const group = task[field];
      if (group && task.project_id === projectId) (out[group] ??= []).push(task);
    }
    const order = (task: Task) => CATEGORIES.indexOf(statuses[task.status_id]?.category ?? "backlog");
    for (const list of Object.values(out)) list.sort((a, b) => order(a) - order(b) || (a.rank < b.rank ? -1 : 1));
    return out;
  }, [tasks, statuses, projectId, field]);
}

function countDone(tasks: Task[], statuses: Dict<Status>): number {
  return tasks.filter((task) => statuses[task.status_id]?.category === "done").length;
}

function Meter({ tasks }: { tasks: Task[] }) {
  const statuses = useCollection("statuses");
  const done = countDone(tasks, statuses);
  const total = tasks.length;
  return (
    <span className="flex shrink-0 items-center gap-2" role="img" aria-label={t("epics.progress", { done, total })}>
      <span className="w-9 text-right text-xs text-ink-3 tnum">
        {done}/{total}
      </span>
      <span className="h-1 w-20 overflow-hidden rounded-full bg-sunken max-sm:w-10">
        <span className="block h-full rounded-full bg-ok" style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
      </span>
    </span>
  );
}

interface Props {
  name: string;
  /** Shown right after the name: a state, "Current". */
  badge?: ReactNode;
  /** Shown at the right, before the meter: dates, the lead. */
  meta?: ReactNode;
  tasks: Task[];
  open: boolean;
  onToggle: () => void;
  /** What to say, opened, when it has no tasks. */
  emptyText: string;
  hide?: { epic?: boolean };
}

/** An epic or a cycle as one dense line; click it to see its tasks underneath. */
export function PlanRow({ name, badge, meta, tasks, open, onToggle, emptyText, hide }: Props) {
  return (
    <li>
      <div className="relative flex h-9 items-center gap-2 border-b border-line/70 pr-3 pl-2 text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? "list.collapse" : "list.expand", { name })}
          onClick={onToggle}
          className="flex min-w-0 items-center gap-1.5 text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
        >
          <ChevronRight className={cx("size-4 shrink-0 text-ink-3", open && "rotate-90")} aria-hidden />
          <span className="truncate font-medium">{name}</span>
        </button>
        {badge}
        <span className="flex-1" />
        {meta}
        <Meter tasks={tasks} />
      </div>
      {open && (
        <div className="border-b border-line bg-surface pl-5">
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
