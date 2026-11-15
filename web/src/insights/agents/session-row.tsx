// One recorded agent run as a line that opens in place: what it was asked,
// what it did step by step, what it produced and what it cost. Used on the
// agents page and in the task panel.

import { useState } from "react";
import { Check, ChevronRight, Loader, Square, X } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMember, useRowEvenIfGone } from "@/lib/selectors";
import { ago, exact } from "@/lib/time";
import type { AgentSession } from "@/lib/types";
import { moneyMicros, short } from "@/insights/lib/amounts";
import { span } from "@/insights/lib/durations";
import { sessionLink, stepText } from "@/insights/agents/session-data";
import { useTaskLink } from "@/lib/task-link";
import { Avatar } from "@/ui/avatar";

const marks = {
  running: { icon: Loader, tone: "text-accent-text" },
  done: { icon: Check, tone: "text-ok" },
  failed: { icon: X, tone: "text-danger" },
  stopped: { icon: Square, tone: "text-ink-3" },
} as const;

type StateName = keyof typeof marks;
const stateOf = (s: AgentSession): StateName => (s.state in marks ? (s.state as StateName) : "stopped");

/** How long a run took, or has taken so far. */
export function sessionLength(s: AgentSession, now: number): string {
  const ms = Math.max(0, (s.ended_at ?? now) - s.started_at);
  return ms < 60_000 ? t("agents.session.underMinute") : span(ms);
}

function StateMark({ session }: { session: AgentSession }) {
  const state = stateOf(session);
  const { icon: Icon, tone } = marks[state];
  const label = t(`agents.session.${state}`);
  return (
    <span className={cx("flex size-4 shrink-0 items-center justify-center", tone)} title={label}>
      <Icon
        className={cx("size-3.5", state === "running" && "animate-spin [animation-duration:2.4s]")}
        strokeWidth={2.4}
        aria-hidden
      />
      <span className="sr-only">{label}</span>
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

function SessionBody({ session, now }: { session: AgentSession; now: number }) {
  const steps = session.steps ?? [];
  const links = session.links ?? [];
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
        <h4 className={heading}>{t("agents.session.steps", { n: steps.length })}</h4>
        {steps.length === 0 ? (
          <p className="text-ink-3">{t("agents.session.noSteps")}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {steps.map((step, i) => {
              const { text, tool } = stepText(step);
              return (
                <li key={i} className="flex gap-2">
                  <span className="w-4 shrink-0 text-right text-xs leading-5 text-ink-3 tnum">{i + 1}</span>
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
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
        <Fact label={t("agents.session.cost")}>{moneyMicros(session.cost_micros)}</Fact>
        <Fact label={t("agents.session.tokensIn")}>{short(session.tokens_in)}</Fact>
        <Fact label={t("agents.session.tokensOut")}>{short(session.tokens_out)}</Fact>
        <Fact label={t("agents.session.started")}>{exact(session.started_at)}</Fact>
        <Fact label={t(session.ended_at ? "agents.session.took" : "agents.session.runningFor")}>
          {sessionLength(session, now)}
        </Fact>
      </dl>
    </div>
  );
}

interface Props {
  session: AgentSession;
  now: number;
  /** Name the agent on the line (the task panel does; an agent's own card does not). */
  showAgent?: boolean;
  /** Name the task on the line (an agent's card does; the task panel does not). */
  showTask?: boolean;
}

export function SessionRow({ session, now, showAgent, showTask }: Props) {
  const [open, setOpen] = useState(false);
  const agent = useMember(showAgent ? session.agent_id : undefined);
  const title = session.title || t("agents.session.untitled");
  const running = session.state === "running";
  return (
    <li className="border-b border-line/70 last:border-b-0">
      <div className="relative flex min-h-8 items-center gap-1.5 py-1 text-sm max-md:min-h-10">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? "agents.session.collapse" : "agents.session.expand", { title })}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
        >
          <ChevronRight className={cx("size-3.5 shrink-0 text-ink-3", open && "rotate-90")} aria-hidden />
          <StateMark session={session} />
          {agent && <Avatar member={agent} size="xs" />}
          <span className="min-w-0 truncate">{title}</span>
        </button>
        {showTask && session.task_id && <TaskKey taskId={session.task_id} />}
        {!!session.cost_micros && (
          <span className="shrink-0 text-xs text-ink-2 tnum">{moneyMicros(session.cost_micros)}</span>
        )}
        <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(session.started_at)}>
          {running ? t("agents.session.elapsed", { time: sessionLength(session, now) }) : ago(session.started_at, now)}
        </span>
      </div>
      {open && <SessionBody session={session} now={now} />}
    </li>
  );
}
