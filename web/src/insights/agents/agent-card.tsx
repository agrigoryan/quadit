// One agent, as a card, read in this order: who it is and where it lives;
// whether it is connected, what hears it and what to do about it, in the
// desktop app's words for the same state (insights/agents/agent-reach.tsx);
// then, below a line, what it works on, what waits on it, and its recent
// runs. A small menu has the rest. In the desktop app the card knows what
// this computer connects (ui/desktop-agents.ts), and what changes files here
// opens the app's Connect window on the agent; a browser offers what a page
// can do.

import { useState } from "react";
import { CornerDownRight, MoreHorizontal, Settings2, Trash2, Unplug } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { t } from "@/lib/i18n";
import { ago, exact, parseWhen, timeOfDay } from "@/lib/time";
import { isOpenSession, type AgentSession, type Member, type Task } from "@/types/core";
import { useCan } from "@/data/access";
import { useLookup, useRowEvenIfGone } from "@/data/selectors";
import { count } from "@/lib/amounts";
import type { AgentState } from "@/types/dashboard";
import type { Claim } from "@/types/agents";
import { AgentStateChip, isStranded, NotListening } from "@/insights/ui/agent-state";
import { connectionOf } from "@/data/listening";
import type { AgentWork } from "@/insights/agents/agent-data";
import { ConnectIt, ConnectionPill, Hearing } from "@/insights/agents/agent-reach";
import { SessionRow, StopRun } from "@/insights/agents/session-row";
import { useSettingsBase } from "@/settings/base";
import { isFinishedHelper } from "@/settings/agents/helper-agents";
import { RemoveAgentDialog } from "@/settings/agents/remove-agent";
import { useTaskLink } from "@/nav/task-link";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/button";
import { type LocalAgent, openConnect } from "@/ui/desktop-agents";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
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
  const held = work.held.filter((task) => (task.lease_until ?? 0) > now);
  // The task a running session is on is named even if it has since been archived or trashed.
  const sessionTask = useRowEvenIfGone("tasks", running?.task_id);
  const lines: React.ReactNode[] = [];
  if (running) {
    lines.push(
      <p key="run" className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate font-medium">{running.title || t("agents.session.untitled")}</span>
        <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(running.started_at)}>
          {t("agents.session.startedAgo", { time: ago(running.started_at, now) })}
        </span>
        <span className="ml-auto shrink-0 self-center">
          <StopRun session={running} />
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
  const statuses = useLookup("statuses");
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

/** The program it was connected through and, when known, the computer it lives on. */
function whereItLives(state: AgentState | undefined, local: LocalAgent | undefined): string {
  const program = state?.tool || local?.programName || "";
  const computer = state?.listeners.find((l) => l.runner)?.runner?.machine || local?.computer || "";
  if (!program) return "";
  return computer ? t("agents.card.where", { program, computer }) : program;
}

/** The card's menu: the agent's settings; in the app, disconnecting it from this computer; removing it, for an admin. */
function CardMenu({ member, local }: { member: Member; local: LocalAgent | undefined }) {
  const can = useCan();
  const settings = useSettingsBase();
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={t("agents.card.more", { name: member.name })} size="sm" className="-mr-1 max-md:size-8">
            <MoreHorizontal className="size-3.5" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Settings2 />} onSelect={() => void navigate(`${settings}/agents/${member.handle}`)}>
            {t("agents.card.settings")}
          </MenuItem>
          {local && (
            <MenuItem icon={<Unplug />} onSelect={() => openConnect(member.user_id, "disconnect")}>
              {t("agents.card.disconnect")}
            </MenuItem>
          )}
          {can.administer && (
            <MenuItem danger icon={<Trash2 />} onSelect={() => setRemoving(true)}>
              {t("agent.remove")}
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      <RemoveAgentDialog agent={member} open={removing} onOpenChange={setRemoving} />
    </>
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
  /** The agents the desktop app on this computer connects; null outside the app (see useLocalAgents). */
  app: Record<string, LocalAgent> | null;
  now: number;
}

function claimLine(claim: Claim, name: string): string {
  if (claim.state === "holding") return t("agents.claim.holding", { name, time: timeOfDay(claim.lease_until ?? 0) });
  return t("agents.claim.waiting", { name });
}

export function AgentCard({ member, state, helpers, helperNote, work, sessions, resourceNames, app, now }: Props) {
  const local = app?.[member.user_id];
  const [allSessions, setAllSessions] = useState(false);
  const settings = useSettingsBase();
  const where = whereItLives(state, local);
  const running = sessions.find(isOpenSession);
  const waits = work.asked.length + work.waiting.length;
  const shown = allSessions ? sessions : sessions.slice(0, SHOWN);
  const connected = connectionOf(member, state) !== "not_connected";
  const busy = !!running?.machine_id;
  const seen = parseWhen(state?.last_seen);
  return (
    <article
      aria-label={member.name}
      className="flex min-w-0 flex-col gap-3 border-r border-b border-line bg-surface p-4"
    >
      {/* Who it is and where it lives; whether it is connected, as the app's card says it. */}
      <header className="flex min-w-0 items-start gap-3">
        <Avatar member={member} size="lg" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          {/* The pill and the menu share the name's line, so the line under it has the card's whole width. */}
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-base leading-5 font-semibold">
              <Link to={`${settings}/agents/${member.handle}`} className="underline-offset-2 hover:underline">
                {member.name}
              </Link>
            </h3>
            {isFinishedHelper(member) ? (
              <Badge>{t("agents.helper.finished")}</Badge>
            ) : (
              <ConnectionPill connected={connected} />
            )}
            <CardMenu member={member} local={local} />
          </div>
          {/* The computer's name is never cut: it takes a line of its own when it does not fit beside the handle. */}
          <p className="flex min-w-0 flex-wrap gap-x-2 text-xs text-ink-3">
            <span>@{member.handle}</span>
            {where && <span>{where}</span>}
          </p>
          {(helperNote || member.title) && (
            <p className="truncate text-xs text-ink-2">{[helperNote, member.title].filter(Boolean).join(" · ")}</p>
          )}
        </div>
      </header>

      {/* What hears it, a line each, in the app's words; or the way to connect it. */}
      {connected ? (
        state && <Hearing member={member} state={state} local={local} busy={busy} />
      ) : (
        <ConnectIt member={member} app={app} />
      )}

      {/* What it works on, below the line. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-3 text-xs text-ink-3">
        {state && <AgentStateChip state={state.state} />}
        <span className="min-w-0 truncate" title={seen ? exact(seen) : undefined}>
          {seen ? t("agents.lastActed", { when: ago(seen, now) }) : t("agents.neverActed")}
          {seen > 0 && state?.last_action && <span className="ml-1 text-ink-2">{state.last_action}</span>}
        </span>
      </div>
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

      <section>
        <h4 className={label}>{t("agents.sessions")}</h4>
        {sessions.length === 0 ? (
          <p className="text-sm text-ink-3">{t("agents.sessions.none")}</p>
        ) : (
          <ul>
            {shown.map((s) => (
              <SessionRow key={s.id} session={s} now={now} showTask noStop />
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
