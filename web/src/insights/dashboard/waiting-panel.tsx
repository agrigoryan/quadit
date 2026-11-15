// "Waiting on me": the questions asked of me and the tasks handed to me,
// oldest first, each one click from where it is answered. Read from the
// store, so a new one appears the moment it is asked.

import { useMemo } from "react";
import { Hourglass } from "lucide-react";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useCollection, useLiveTasks, useMe, useMember } from "@/lib/selectors";
import { exact } from "@/lib/time";
import { type Decision, isOpenCategory, type Task } from "@/lib/types";
import { MoveCount, Panel, PanelEmpty } from "@/insights/ui/panel";
import { useTaskLink } from "@/lib/task-link";
import { Avatar } from "@/ui/avatar";
import { DecisionMark } from "@/ui/icons";
import { Ago } from "@/ui/ago";

interface Item {
  id: string;
  task: Task;
  question?: Decision;
  /** When it came to me, as near as the store knows. */
  since: number;
}

function useWaiting(projectId: string | undefined): Item[] {
  const me = useMe();
  const tasks = useLiveTasks();
  const all = useCollection("tasks");
  const statuses = useCollection("statuses");
  const decisions = useCollection("decisions");
  return useMemo(() => {
    const out: Item[] = [];
    const inScope = (task: Task) => !projectId || task.project_id === projectId;
    for (const task of tasks) {
      if (task.waiting_on_id === me.user_id && inScope(task) && isOpenCategory(statuses[task.status_id]?.category)) {
        out.push({ id: `t:${task.id}`, task, since: task.updated_at });
      }
    }
    for (const d of Object.values(decisions)) {
      if (d.state !== "open" || d.deleted_at || d.asked_id !== me.user_id) continue;
      const task = all[d.task_id];
      if (task && !task.deleted_at && inScope(task))
        out.push({ id: `d:${d.id}`, task, question: d, since: d.created_at });
    }
    return out.sort((a, b) => a.since - b.since);
  }, [tasks, all, statuses, decisions, me.user_id, projectId]);
}

function Row({ item }: { item: Item }) {
  const { task, question } = item;
  const link = useTaskLink(task);
  // A question shows who asked it; a task shows whose work is held up.
  const other = useMember(question ? question.created_by : task.assignee_id);
  return (
    <li className="relative flex min-h-9 items-center gap-2 border-b border-line/70 py-1.5 pr-4 pl-4 text-sm hover:bg-hover">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {question ? (
          <DecisionMark mine title={t("dash.waiting.question")} />
        ) : (
          <span
            role="img"
            aria-label={t("dash.waiting.task")}
            className="flex size-[15px] items-center justify-center rounded-xs bg-move text-move-ink"
          >
            <Hourglass className="size-2.5" strokeWidth={2.5} aria-hidden />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          {...link}
          className="block truncate font-medium outline-none after:absolute after:inset-0 after:content-['']"
        >
          {question ? question.question : task.title}
        </Link>
        <p className="truncate text-xs text-ink-3">
          <span className="tnum">{task.key}</span>
          {question ? ` ${task.title}` : task.waiting_on_note ? ` ${task.waiting_on_note}` : ""}
        </p>
      </div>
      <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(item.since)}>
        <Ago ms={item.since} />
      </span>
      <Avatar member={other} size="sm" />
    </li>
  );
}

export function WaitingPanel({ projectId, className }: { projectId: string | undefined; className?: string }) {
  const items = useWaiting(projectId);
  return (
    <Panel
      title={t("dash.waiting")}
      meta={items.length > 0 ? <MoveCount n={items.length} /> : undefined}
      action={
        items.length > 0 ? (
          <span className="text-xs text-ink-3 max-sm:hidden">{t("dash.waiting.hint")}</span>
        ) : undefined
      }
      className={className}
      flush
    >
      {items.length === 0 ? (
        <PanelEmpty>{t("dash.waiting.empty")}</PanelEmpty>
      ) : (
        <ul className="border-t border-line/70">
          {items.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
