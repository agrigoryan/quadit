// One recorded agent run as a line that opens in place: its state first,
// what it was asked, what it did step by step, what it produced, and when
// it started and ended. A run Quadit's runner started on a computer also
// names the computer, says why it waits, did not start or failed and what
// to do about it, can be stopped by whoever may change its task, and, once
// it ended, gives the agent's responsible person the line that continues
// its session in a terminal. Used on the agents page and in the task panel.

import { useState } from "react";
import { Check, ChevronRight, CircleHelp, Clock, Loader, type LucideIcon, Minus, Square, X } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { isKey, t, tMaybe } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { send } from "@/data/mutate";
import { useMe, useMember, useRowEvenIfGone } from "@/data/selectors";
import { ago, exact, lengthOfHours } from "@/lib/time";
import { type AgentSession, type Decision, isOpenSession, type Member, type SessionState } from "@/types/core";
import { revealDecision } from "@/insights/decisions/reveal";
import { resumeLine } from "@/insights/agents/resume-line";
import { sessionLink, stepText } from "@/insights/agents/session-data";
import { useTaskLink } from "@/nav/task-link";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { CopyField } from "@/ui/reveal-dialog";

/** What a line shows as its state: the session's own, or, for a run done whose agent asked a question since, that it waits for an answer. */
type Shown = SessionState | "awaiting";

const marks: Record<Shown, { icon: LucideIcon; tone: string }> = {
  waiting: { icon: Clock, tone: "text-ink-2" },
  running: { icon: Loader, tone: "text-accent-text" },
  done: { icon: Check, tone: "text-ok" },
  awaiting: { icon: CircleHelp, tone: "text-wait" },
  failed: { icon: X, tone: "text-danger" },
  stopped: { icon: Square, tone: "text-ink-2" },
  not_started: { icon: Minus, tone: "text-ink-2" },
};

/** The state as a mark and its word, read first on the line. */
function StateMark({ shown }: { shown: Shown }) {
  const { icon: Icon, tone } = marks[shown];
  return (
    <span className={cx("flex shrink-0 items-center gap-1 text-xs font-medium", tone)}>
      <Icon
        className={cx("size-3.5", shown === "running" && "animate-spin [animation-duration:2.4s]")}
        strokeWidth={2.4}
        aria-hidden
      />
      {t(`agents.session.${shown}`)}
    </span>
  );
}

function TaskKey({ taskId }: { taskId: string }) {
  // A past session names its task even after the task is archived or trashed.
  const task = useRowEvenIfGone("tasks", taskId);
  const link = useTaskLink({ key: task?.key ?? "" });
  if (!task) return null;
  return (
    <Link
      {...link}
      title={task.title}
      className="relative z-[1] shrink-0 text-xs text-ink-3 tnum underline-offset-2 hover:text-ink hover:underline"
    >
      {task.key}
    </Link>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink tnum">{children}</dd>
    </div>
  );
}

/** What a run's words name: the agent, the person responsible for it, the computer, the program, a time. */
function wordsOf(session: AgentSession, agent: Member | undefined, owner: Member | undefined) {
  return {
    agent: agent ? `@${agent.handle}` : t("common.agent"),
    owner: owner?.name ?? t("common.someone"),
    machine: session.machine_name ?? "",
    program: tMaybe(`run.program.${session.program ?? ""}`, session.program ?? ""),
    time: session.resets_at ? exact(session.resets_at) : "",
  };
}

/**
 * Why a runner's run waits, did not start or failed, and what to do about
 * it: two short lines, always shown. Nothing for a reason this page has no
 * words for.
 */
function Reason({ session, agent }: { session: AgentSession; agent: Member | undefined }) {
  const owner = useMember(agent?.responsible_id);
  const code = session.reason ?? "";
  const reason = `agents.run.reason.${code}`;
  const todo =
    code === "usage_limit" && !session.resets_at ? "agents.run.todo.usage_limitUnknown" : `agents.run.todo.${code}`;
  if (!isKey(reason)) return null;
  const words = wordsOf(session, agent, owner);
  return (
    <>
      <span className="text-ink-2">{t(reason, words)}</span>
      {isKey(todo) && <span>{t(todo, words)}</span>}
    </>
  );
}

/** The question the agent asked after its run, linking to it on the task. */
function Asked({ question, agent, taskKey }: { question: Decision; agent: Member | undefined; taskKey: string }) {
  const link = useTaskLink({ key: taskKey });
  return (
    <Link
      {...link}
      onClick={() => revealDecision(question.id)}
      className="w-fit text-ink-2 underline-offset-2 hover:text-ink hover:underline"
    >
      {t("agents.session.asked", {
        agent: agent ? `@${agent.handle}` : t("common.agent"),
        question: question.question,
      })}
    </Link>
  );
}

/**
 * Asks a runner's open run to stop, for whoever may change its task;
 * nothing for anyone else, or for a run that ended or that Quadit did not
 * start. The runner stops the program; until the run's state says so, the
 * button says it is stopping. Used on the run's line and on its agent's
 * card.
 */
export function StopRun({ session }: { session: AgentSession }) {
  const agent = useMember(session.agent_id);
  const task = useRowEvenIfGone("tasks", session.task_id);
  const can = useCan();
  if (!session.machine_id || !isOpenSession(session) || !task || !can.editTask(task)) return null;
  const stopping = !!session.stop_requested_at;
  return (
    <Button
      size="sm"
      disabled={stopping}
      aria-label={
        stopping
          ? undefined
          : t("agents.session.stopLabel", { agent: agent ? `@${agent.handle}` : t("common.agent"), key: task.key })
      }
      className="relative z-[1] text-ink-2"
      onClick={() => send({ type: "session.stop", args: { id: session.id } })}
    >
      {!stopping && <Square className="size-2.5 fill-current" aria-hidden />}
      {t(stopping ? "agents.session.stopping" : "agents.session.stop")}
    </Button>
  );
}

function SessionBody({ session, resume }: { session: AgentSession; resume: string | null }) {
  const steps = session.steps ?? [];
  const links = session.links ?? [];
  const dropped = session.steps_dropped ?? 0;
  const heading = "mb-0.5 text-xs font-medium text-ink-2";
  return (
    <div className="flex flex-col gap-2.5 pt-1 pr-2 pb-3 pl-7 text-sm">
      {session.instructions && (
        <div>
          <h4 className={heading}>{t("agents.session.instructions")}</h4>
          <p className="whitespace-pre-wrap text-ink">{session.instructions}</p>
        </div>
      )}
      {session.summary && (
        <div>
          <h4 className={heading}>{t("agents.session.summary")}</h4>
          <p className="whitespace-pre-wrap text-ink">{session.summary}</p>
        </div>
      )}
      <div>
        <h4 className={heading}>{t("agents.session.steps", { n: dropped + steps.length })}</h4>
        {dropped > 0 && <p className="text-xs text-ink-3">{t("agents.session.stepsDropped", { n: dropped })}</p>}
        {steps.length === 0 ? (
          <p className="text-ink-3">{t("agents.session.noSteps")}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {steps.map((step, i) => {
              const { text, tool } = stepText(step);
              return (
                <li key={dropped + i} className="flex gap-2">
                  <span className="w-6 shrink-0 text-right text-xs leading-5 text-ink-3 tnum">{dropped + i + 1}</span>
                  <span className="min-w-0 break-words">
                    {text}
                    {tool && <span className="ml-1.5 rounded-xs bg-sunken px-1 py-px text-xs text-ink-2">{tool}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {links.length > 0 && (
        <div>
          <h4 className={heading}>{t("agents.session.links")}</h4>
          <ul className="flex flex-col gap-0.5">
            {links.map((raw, i) => {
              const link = sessionLink(raw);
              return (
                <li key={i} className="min-w-0 truncate">
                  {link.url ? (
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent-text underline-offset-2 hover:underline"
                    >
                      {link.name}
                    </a>
                  ) : (
                    link.name
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {resume && (
        <div className="flex flex-col gap-1">
          <CopyField label={t("agents.session.resume", { machine: session.machine_name ?? "" })} value={resume} />
          <p className="text-xs text-ink-3">{t("agents.session.resumeNote")}</p>
        </div>
      )}
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
        <Fact label={t("agents.session.started")}>{exact(session.started_at)}</Fact>
        {!!session.ended_at && <Fact label={t("agents.session.ended")}>{exact(session.ended_at)}</Fact>}
      </dl>
    </div>
  );
}

/** When the line says it happened: a runner's run says when it was received, or how long it has worked. */
function timing(session: AgentSession, now: number): string {
  const runner = !!session.machine_id;
  if (runner && session.state === "waiting")
    return t("agents.session.received", { time: ago(session.started_at, now) });
  if (runner && session.state === "running") {
    const since = session.accepted_at ?? session.started_at;
    return t("agents.session.working", { duration: lengthOfHours((now - since) / 3_600_000) });
  }
  if (isOpenSession(session)) return t("agents.session.startedAgo", { time: ago(session.started_at, now) });
  return ago(session.started_at, now);
}

interface Props {
  session: AgentSession;
  now: number;
  /** Name the agent on the line (the task panel does; an agent's own card does not). */
  showAgent?: boolean;
  /** Name the task on the line (an agent's card does; the task panel does not). */
  showTask?: boolean;
  /**
   * The open question its agent asked on the task, given for the newest run Quadit
   * started for that agent there: a run done then waits for its answer.
   */
  question?: Decision;
  /** It is the newest run Quadit's runner started for its agent on its task: once ended, it may be continued in a terminal. */
  newestRun?: boolean;
  /** Leave Stop off the line: the page shows it elsewhere (an agent's card, on the run in hand). */
  noStop?: boolean;
}

export function SessionRow({ session, now, showAgent, showTask, question, newestRun, noStop }: Props) {
  const [open, setOpen] = useState(false);
  const agent = useMember(session.agent_id);
  const me = useMe();
  const task = useRowEvenIfGone("tasks", session.task_id);
  const title = session.title || t("agents.session.untitled");
  const runner = !!session.machine_id;
  const shown: Shown = session.state === "done" && question ? "awaiting" : session.state;
  // Only the person the agent works for continues its session, on the computer it ran on.
  const resume =
    runner && newestRun && !isOpenSession(session) && !!agent && agent.responsible_id === me.user_id
      ? resumeLine(session)
      : null;
  const stoppedBy = useMember(session.state === "stopped" ? session.stop_requested_by : undefined);
  const notes = "flex flex-col gap-0.5 pb-1.5 pl-5 text-xs text-ink-3";
  return (
    <li className="border-b border-line/70 last:border-b-0">
      <div className="relative flex min-h-8 items-center gap-1.5 py-1 text-sm max-md:min-h-10">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? "agents.session.collapse" : "agents.session.expand", { title })}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left md:min-w-auto outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
        >
          <ChevronRight className={cx("size-3.5 shrink-0 text-ink-3", open && "rotate-90")} aria-hidden />
          <StateMark shown={shown} />
          {showAgent && agent && <Avatar member={agent} size="xs" />}
          {/* Past phone width the title keeps a few words: the computer's name gives way first. */}
          <span className="min-w-0 truncate md:min-w-24">{title}</span>
        </button>
        {runner && session.machine_name && (
          <span className="max-w-40 min-w-0 shrink truncate text-xs text-ink-3 max-md:hidden" title={session.folder}>
            {session.machine_name}
          </span>
        )}
        {showTask && session.task_id && <TaskKey taskId={session.task_id} />}
        <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(session.started_at)}>
          {timing(session, now)}
        </span>
        {!noStop && <StopRun session={session} />}
      </div>
      {runner && session.reason && (
        <p className={notes}>
          <Reason session={session} agent={agent} />
        </p>
      )}
      {session.state === "stopped" && session.stop_requested_by && (
        <p className={notes}>{t("agents.session.stoppedBy", { name: stoppedBy?.name ?? t("common.someone") })}</p>
      )}
      {shown === "awaiting" && question && task && (
        <p className={notes}>
          <Asked question={question} agent={agent} taskKey={task.key} />
        </p>
      )}
      {open && <SessionBody session={session} resume={resume} />}
    </li>
  );
}
