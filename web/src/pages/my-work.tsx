import { useMemo } from "react";
import { Link } from "react-router";
import { FirstProjectNudge } from "@/auth/first-run";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCollection, useLiveTasks, useMe, useMember } from "@/lib/selectors";
import { exact } from "@/lib/time";
import { CATEGORIES, type Category, type Decision, isOpenCategory, type Task } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { useListKeys } from "@/pages/list-keys";
import { useOpenTask } from "@/pages/open-task";
import { keyCell, keyColumn, TaskRow, useTaskLink } from "@/tasks/task-row";
import { Avatar } from "@/ui/avatar";
import { DecisionMark } from "@/ui/icons";
import { Ago } from "@/ui/ago";

/** What is being worked on comes first, then what is next, then the rest. */
const CATEGORY_ORDER: Category[] = ["started", "waiting", "unstarted", "backlog"];
const categoryRank = (c: Category | undefined) => {
  const i = c ? CATEGORY_ORDER.indexOf(c) : -1;
  return i < 0 ? CATEGORIES.length : i;
};
/** Urgent (1) first, no priority (0) last. */
const priorityRank = (p: number) => (p === 0 ? 5 : p);

interface Question {
  decision: Decision;
  task: Task;
}

type Row = { id: string; task: Task; question?: Decision };

/**
 * My work: first everything that waits on me (tasks handed to me and
 * questions asked of me), then the open tasks assigned to me.
 */
export function MyWorkPage() {
  usePageTitle(t("nav.myWork"));
  const me = useMe();
  const tasks = useLiveTasks();
  const allTasks = useCollection("tasks");
  const statuses = useCollection("statuses");
  const decisions = useCollection("decisions");
  const openTask = useOpenTask();

  const { waiting, questions, assigned } = useMemo(() => {
    const open = tasks.filter((task) => isOpenCategory(statuses[task.status_id]?.category));
    const waiting = open.filter((task) => task.waiting_on_id === me.user_id).sort((a, b) => b.updated_at - a.updated_at);
    const questions: Question[] = [];
    for (const decision of Object.values(decisions)) {
      if (decision.state !== "open" || decision.deleted_at || decision.asked_id !== me.user_id) continue;
      const task = allTasks[decision.task_id];
      if (task && !task.deleted_at) questions.push({ decision, task });
    }
    questions.sort((a, b) => b.decision.created_at - a.decision.created_at);
    const assigned = open
      .filter((task) => task.assignee_id === me.user_id && task.waiting_on_id !== me.user_id)
      .sort(
        (a, b) =>
          categoryRank(statuses[a.status_id]?.category) - categoryRank(statuses[b.status_id]?.category) ||
          priorityRank(a.priority) - priorityRank(b.priority) ||
          b.updated_at - a.updated_at,
      );
    return { waiting, questions, assigned };
  }, [tasks, allTasks, statuses, decisions, me.user_id]);

  const rows = useMemo<Row[]>(
    () => [
      ...waiting.map((task) => ({ id: `w:${task.id}`, task })),
      ...questions.map((q) => ({ id: `q:${q.decision.id}`, task: q.task, question: q.decision })),
      ...assigned.map((task) => ({ id: `a:${task.id}`, task })),
    ],
    [waiting, questions, assigned],
  );
  const focusId = useListKeys({ rows, idOf: (row) => row.id, onOpen: (row) => openTask(row.task.key) });
  const yours = waiting.length + questions.length;
  const keyStyle = useMemo(() => keyColumn(rows.map((row) => row.task.key)), [rows]);

  return (
    <div className="h-full overflow-y-auto pb-10" style={keyStyle}>
      <FirstProjectNudge />
      <section aria-labelledby="mywork-waiting">
        <header className="flex min-h-12 flex-wrap items-center gap-x-2.5 border-b border-line px-4 pt-3 pb-2">
          <h2 id="mywork-waiting" className="text-base font-semibold">
            {t("mywork.waiting")}
          </h2>
          {yours > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-sm bg-move px-1.5 text-xs font-semibold text-move-ink tnum">
              {yours}
            </span>
          )}
          {yours > 0 && <p className="text-xs text-ink-3 max-sm:hidden">{t("mywork.waitingHint")}</p>}
        </header>
        {yours === 0 && <p className="border-b border-line/70 px-4 py-2 text-sm text-ink-2">{t("mywork.waitingEmpty")}</p>}
        {waiting.map((task) => (
          <TaskRow key={task.id} task={task} focused={focusId === `w:${task.id}`} />
        ))}
        {questions.map((q) => (
          <QuestionRow key={q.decision.id} decision={q.decision} task={q.task} focused={focusId === `q:${q.decision.id}`} />
        ))}
      </section>

      <section aria-labelledby="mywork-assigned" className="mt-5">
        <header className="flex h-9 items-center gap-2 border-b border-line px-4">
          <h2 id="mywork-assigned" className="text-sm font-semibold">
            {t("mywork.assigned")}
          </h2>
          {assigned.length > 0 && <span className="text-xs text-ink-3 tnum">{assigned.length}</span>}
        </header>
        {assigned.length === 0 && (
          <div className="px-4 py-2 text-sm">
            <p className="text-ink-2">{t("mywork.assignedEmpty")}</p>
            <p className="mt-0.5 text-xs text-ink-3">{t("mywork.assignedEmptyHint")}</p>
          </div>
        )}
        {assigned.map((task) => (
          <TaskRow key={task.id} task={task} focused={focusId === `a:${task.id}`} />
        ))}
      </section>
    </div>
  );
}

/** A question asked of me, laid out on the same columns as a task row. */
function QuestionRow({ decision, task, focused }: { decision: Decision; task: Task; focused: boolean }) {
  const asker = useMember(decision.created_by);
  const link = useTaskLink(task);
  return (
    <div
      data-focused={focused || undefined}
      className={cx(
        "relative flex h-9 items-center gap-1.5 border-b border-line/70 pr-3 pl-1.5 text-sm",
        focused ? "bg-hover" : "bg-surface",
      )}
    >
      {focused && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      <span className="size-6 shrink-0 max-sm:hidden" aria-hidden />
      <span className={cx(keyCell, "max-sm:hidden")}>{task.key}</span>
      <span className="flex size-6 shrink-0 items-center justify-center">
        <DecisionMark mine title={t("task.decisionYours")} />
      </span>
      <Link {...link} className="min-w-0 shrink truncate py-2 font-medium outline-none after:absolute after:inset-0 after:content-['']">
        {decision.question}
      </Link>
      <span className="min-w-0 flex-1 basis-0 truncate text-ink-3">
        <span className="tnum sm:hidden">{task.key}</span>
        <span className="max-md:hidden">{task.title}</span>
      </span>
      <span className="relative z-[1] flex shrink-0 items-center gap-2" title={asker ? t("mywork.askedBy", { name: asker.name }) : undefined}>
        <span className="text-xs text-ink-3 tnum" title={exact(decision.created_at)}>
          <Ago ms={decision.created_at} />
        </span>
        <span className="flex size-6 items-center justify-center">
          <Avatar member={asker} size="sm" />
        </span>
      </span>
    </div>
  );
}
