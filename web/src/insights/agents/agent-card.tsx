// One agent, as a card: what it is doing right now, what waits on it,
// whether anything would wake it, what it spent this week, and its recent
// runs.

import { useState } from "react";
import { CornerDownRight, Ear } from "lucide-react";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { ago, exact, timeOfDay } from "@/lib/time";
import type { AgentSession, Member, Task } from "@/lib/types";
import { useStore } from "@/lib/store";
import { count, parseWhen } from "@/insights/lib/format";
import type { AgentState, Claim } from "@/insights/lib/types";
import { AgentStateChip, BudgetBar, isStranded, NotListening } from "@/insights/ui/agent-state";
import type { AgentWork } from "@/insights/agents/agent-data";
import { SessionRow, sessionLength } from "@/insights/agents/session-row";
import { isFinishedHelper } from "@/settings/agents/helper-agents";
import { useTaskLink } from "@/lib/task-link";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { DecisionMark, StatusIcon } from "@/ui/icons";

const SHOWN = 4;
const label = "text-xs font-medium text-ink-2";

/** A task named in a sentence: its key and title, opening its panel. */
function TaskRef({ task, text }: { task: Pick<Task, "key" | "title">; text?: string }) {
  const link = useTaskLink(task);
  return (
    <Link {...link} className="min-w-0 truncate underline-offset-2 hover:underline">
      <span className="mr-1.5 text-xs text-ink-3 tnum">{task.key}</span>
      {text ?? task.title}
    </Link>
  );
}

/** What the agent has in hand: a running session, a task it holds, or why it has neither. */
function Doing({
  state,
  work,
  running,
  now,
}: {
  state: AgentState | undefined;
  work: AgentWork;
  running: AgentSession | undefined;
  now: number;
}) {
  const tasks = useStore((s) => s.c.tasks);
  const held = work.held.filter((task) => (task.lease_until ?? 0) > now);
  const sessionTask = running?.task_id ? tasks[running.task_id] : undefined;
  const lines: React.ReactNode[] = [];
  if (running) {
    lines.push(
      <p key="run" className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate font-medium">{running.title || t("agents.session.untitled")}</span>
        <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(running.started_at)}>
          {t("agents.session.elapsed", { time: sessionLength(running, now) })}
        </span>
      </p>,
    );
    if (sessionTask && !held.some((h) => h.id === sessionTask.id)) {
      lines.push(
        <p key="on" className="flex min-w-0 text-ink-2">
          <TaskRef task={sessionTask} />
        </p>,
      );
    }
  }
  for (const task of held) {
    lines.push(
      <p key={task.id} className="flex min-w-0 items-baseline gap-1.5">
        <TaskRef task={task} />
        <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(task.lease_until ?? 0)}>
          {t("agents.holdsUntil", { time: timeOfDay(task.lease_until ?? 0) })}
        </span>
      </p>,
    );
  }
  if (lines.length === 0) {
    const text =
      state?.state === "waiting" && state.waits_on
        ? t("agents.doing.waiting", { who: state.waits_on })
        : state?.state === "has_work"
          ? t("agents.doing.hasWork", { n: state.waiting_on_it })
          : state?.state === "working" && state.task
            ? t("agents.doing.working", { task: state.task })
            : t("agents.doing.idle", { n: state?.open_tasks ?? 0 });
    lines.push(
      <p key="none" className="text-ink-2">
        {text}
      </p>,
    );
  }
  return <div className="flex flex-col gap-0.5 text-sm">{lines}</div>;
}

/** Tasks handed to the agent and questions asked of it, oldest first. */
function WaitsOnIt({ work, now }: { work: AgentWork; now: number }) {
  const [all, setAll] = useState(false);
  const statuses = useStore((s) => s.c.statuses);
  const rows = [
    ...work.asked.map(({ decision, task }) => ({
      id: decision.id,
      at: decision.created_at,
      task,
      question: decision.question,
    })),
    ...work.waiting.map((task) => ({
      id: task.id,
      at: task.updated_at,
      task,
      question: undefined as string | undefined,
    })),
  ];
  if (rows.length === 0) return <p className="text-sm text-ink-3">{t("agents.waits.none")}</p>;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <ul className="flex flex-col text-sm">
      {shown.map((row) => (
        <li key={row.id} className="flex min-h-6 min-w-0 items-center gap-1.5 max-md:min-h-8">
          <span className="flex size-4 shrink-0 items-center justify-center">
            {row.question ? (
              <DecisionMark mine={false} title={t("agents.waits.question")} />
            ) : (
              <StatusIcon category={statuses[row.task.status_id]?.category ?? "unstarted"} />
            )}
          </span>
          <TaskRef task={row.task} text={row.question} />
          <span className="flex-1" />
          <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(row.at)}>
            {ago(row.at, now)}
          </span>
        </li>
      ))}
      {rows.length > SHOWN && (
        <li>
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="h-6 text-xs text-accent-text underline-offset-2 hover:underline max-md:h-8"
          >
            {all ? t("agents.showLess") : t("agents.showMore", { n: rows.length - SHOWN })}
          </button>
        </li>
      )}
    </ul>
  );
}

/** Whether anything would wake it, and when it last did something. */
function Reach({ state, now }: { state: AgentState; now: number }) {
  const seen = parseWhen(state.last_seen);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
      {state.listening ? (
        <span className="inline-flex items-center gap-1 text-ink-2" title={t("agents.listeningHint")}>
          <Ear className="size-3" aria-hidden />
          {t("agents.listening")}
        </span>
      ) : (
        <NotListening urgent={isStranded(state)} />
      )}
      <span className="min-w-0 truncate" title={seen ? exact(seen) : undefined}>
        {seen ? t("agents.lastActed", { when: ago(seen, now) }) : t("agents.neverActed")}
        {seen > 0 && state.last_action && <span className="ml-1 text-ink-2">{state.last_action}</span>}
      </span>
    </p>
  );
}

/** A helper this agent made for one task, shown inside its maker's card. */
export interface HelperOf {
  member: Member;
  state: AgentState | undefined;
  /** The task it was made for, when the store has it. */
  task: Task | undefined;
}

function HelperRow({ helper }: { helper: HelperOf }) {
  const { member, state, task } = helper;
  const done = isFinishedHelper(member);
  return (
    <li className="flex min-h-7 min-w-0 items-center gap-1.5 max-md:min-h-8">
      <CornerDownRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <Avatar member={member} size="sm" className={done ? "opacity-60" : undefined} />
      <span className={done ? "shrink-0 text-ink-2" : "shrink-0 font-medium"}>{member.name}</span>
      <span className="flex min-w-0 flex-1 text-ink-2">
        {task ? <TaskRef task={task} /> : <span className="truncate text-ink-3">{t("agents.helper.oneTask")}</span>}
      </span>
      {done ? <Badge>{t("agents.helper.finished")}</Badge> : state ? <AgentStateChip state={state.state} /> : null}
      {!done && state && isStranded(state) && <NotListening urgent />}
    </li>
  );
}

interface Props {
  member: Member;
  /** From the server; missing until the first answer arrives. */
  state: AgentState | undefined;
  /** The helpers it made, each for one task. */
  helpers?: HelperOf[];
  /** For a helper with a card of its own (a person made it): "Helper for SVA-12". */
  helperNote?: string;
  work: AgentWork;
  sessions: AgentSession[];
  /** Names of the shared resources its claims are on. */
  resourceNames: Record<string, string>;
  now: number;
}

function claimLine(claim: Claim, name: string): string {
  if (claim.state === "holding") return t("agents.claim.holding", { name, time: timeOfDay(claim.lease_until ?? 0) });
  return t("agents.claim.waiting", { name });
}

export function AgentCard({ member, state, helpers, helperNote, work, sessions, resourceNames, now }: Props) {
  const [allSessions, setAllSessions] = useState(false);
  const running = sessions.find((s) => s.state === "running");
  const waits = work.asked.length + work.waiting.length;
  const shown = allSessions ? sessions : sessions.slice(0, SHOWN);
  return (
    <article
      aria-label={member.name}
      className="flex min-w-0 flex-col gap-3 border-r border-b border-line bg-surface p-4"
    >
      <header className="flex min-w-0 items-start gap-3">
        <Avatar member={member} size="lg" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-baseline gap-1.5 text-base leading-5 font-semibold">
            <span className="truncate">{member.name}</span>
            <span className="shrink-0 text-xs font-normal text-ink-3">@{member.handle}</span>
          </h3>
          {(helperNote || member.title) && (
            <p className="truncate text-xs text-ink-2">{[helperNote, member.title].filter(Boolean).join(" · ")}</p>
          )}
        </div>
        {isFinishedHelper(member) ? (
          <Badge>{t("agents.helper.finished")}</Badge>
        ) : (
          state && <AgentStateChip state={state.state} />
        )}
      </header>

      <Doing state={state} work={work} running={running} now={now} />
      {work.claims.length > 0 && (
        <ul className="-mt-2 text-xs text-ink-2">
          {work.claims.map((c) => (
            <li key={c.id}>{claimLine(c, resourceNames[c.resource_id] ?? "")}</li>
          ))}
        </ul>
      )}

      {helpers && helpers.length > 0 && (
        <section>
          <h4 className={label}>
            {t("agents.helpers")}
            <span className="ml-1.5 font-normal text-ink-3 tnum">{helpers.length}</span>
          </h4>
          <ul className="flex flex-col text-sm">
            {helpers.map((h) => (
              <HelperRow key={h.member.user_id} helper={h} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4 className={label}>
          {t("agents.waits")}
          {waits > 0 && <span className="ml-1.5 font-normal text-ink-3 tnum">{count(waits)}</span>}
        </h4>
        <WaitsOnIt work={work} now={now} />
      </section>

      {state && <Reach state={state} now={now} />}
      {state && <BudgetBar agent={state} />}

      <section>
        <h4 className={label}>{t("agents.sessions")}</h4>
        {sessions.length === 0 ? (
          <p className="text-sm text-ink-3">{t("agents.sessions.none")}</p>
        ) : (
          <ul>
            {shown.map((s) => (
              <SessionRow key={s.id} session={s} now={now} showTask />
            ))}
          </ul>
        )}
        {sessions.length > SHOWN && (
          <button
            type="button"
            onClick={() => setAllSessions(!allSessions)}
            className="h-6 text-xs text-accent-text underline-offset-2 hover:underline max-md:h-8"
          >
            {allSessions ? t("agents.showLess") : t("agents.showMore", { n: sessions.length - SHOWN })}
          </button>
        )}
      </section>
    </article>
  );
}
