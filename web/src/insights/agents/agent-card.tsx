// One agent, as a card: where it lives, what it is doing right now, what
// waits on it, whether anything would wake it, and its recent runs; and the
// one thing to do about its state (connect it, have it listen, run it, stop
// it), with a small menu for the rest. In the desktop app the card knows what
// this computer connects (ui/desktop-agents.ts), and what changes files here
// opens the app's Connect window on the agent; a browser offers what a page
// can do.

import { useState } from "react";
import { Check, Copy, CornerDownRight, Ear, EarOff, MoreHorizontal, Settings2, Trash2, Unplug } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { t } from "@/lib/i18n";
import { ago, exact, parseWhen, timeOfDay } from "@/lib/time";
import { isOpenSession, type AgentSession, type Member, type Task } from "@/types/core";
import { useCan } from "@/data/access";
import { copyText } from "@/data/files";
import { toast } from "@/lib/toast";
import { useLookup, useRowEvenIfGone } from "@/data/selectors";
import { count } from "@/lib/amounts";
import type { AgentState } from "@/types/dashboard";
import type { Claim } from "@/types/agents";
import { AgentStateChip, isStranded, NotConnected, NotListening } from "@/insights/ui/agent-state";
import { connectionOf } from "@/data/listening";
import type { AgentWork } from "@/insights/agents/agent-data";
import { SessionRow, StopRun } from "@/insights/agents/session-row";
import { useSettingsBase } from "@/settings/base";
import { isFinishedHelper } from "@/settings/agents/helper-agents";
import { RemoveAgentDialog } from "@/settings/agents/remove-agent";
import { useTaskLink } from "@/nav/task-link";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button, buttonLook, IconButton } from "@/ui/button";
import { type LocalAgent, openConnect } from "@/ui/desktop-agents";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { DecisionMark, StatusIcon } from "@/ui/icons";
import { ListenerLines } from "@/ui/listener-lines";

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

/**
 * The one thing to do about the agent's state, when there is one: connect
 * it; with nothing listening, the words that have it listen and, where this
 * computer can, Run by Quadit; stop Quadit running it here. A chat that
 * listens, or a computer elsewhere that runs it, is nothing a page can
 * change. Stopping a run in hand is on the run itself (Doing).
 */
function Action({
  member,
  state,
  app,
  busy,
}: {
  member: Member;
  state: AgentState;
  app: Record<string, LocalAgent> | null;
  busy: boolean;
}) {
  const can = useCan();
  const local = app?.[member.user_id];
  const settings = useSettingsBase();
  if (busy) return null;
  if (local && local.runs.length > 0)
    return (
      <Button size="sm" onClick={() => openConnect(member.user_id, "run")}>
        {t("agents.card.stopRunning")}
      </Button>
    );
  if (state.listeners.some((l) => l.runner)) return null;
  const connection = connectionOf(member, state);
  if (connection === "listening") return null;
  if (connection === "connected")
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-0.5 text-ink-2">
          {t("agents.card.listen")}
          <CopyButton value={t("agents.card.listenWords")} label={t("agents.card.copyListen")} />
        </span>
        {local?.canRun && (
          <Button size="sm" onClick={() => openConnect(member.user_id, "run")}>
            {t("agents.card.runByQuadit")}
          </Button>
        )}
      </span>
    );
  if (!can.agentTokens(member)) return null;
  // In a browser a connect code is made on the agent's page in Settings.
  return app ? (
    <Button size="sm" variant="primary" onClick={() => openConnect(member.user_id, "connect")}>
      {t("agents.card.connect")}
    </Button>
  ) : (
    <Link to={`${settings}/agents/${member.handle}`} className={buttonLook("primary", "sm")}>
      {t("agents.card.connect")}
    </Link>
  );
}

/** How far it is connected, whether anything would wake it, what to do about it, and when it last did something. */
function Reach({
  member,
  state,
  app,
  busy,
  now,
}: {
  member: Member;
  state: AgentState;
  app: Record<string, LocalAgent> | null;
  /** A run Quadit started is in hand: its Stop is the card's one action, on the run. */
  busy: boolean;
  now: number;
}) {
  const seen = parseWhen(state.last_seen);
  const connection = connectionOf(member, state);
  return (
    <div className="flex flex-col gap-1.5 text-xs text-ink-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {connection === "listening" ? (
          <span
            className="inline-flex min-w-0 items-start gap-1.5 text-ink-2"
            title={t("agents.connection.listeningHint")}
          >
            {/* Beside the first line: a runner's line is long and wraps. */}
            <Ear className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
              <ListenerLines reading={state} />
            </span>
          </span>
        ) : state.listeners.some((l) => l.runner && !l.live) ? (
          // Its computer is offline: what runs it there, and that its work waits for it, as Settings says it.
          <span className="inline-flex min-w-0 items-start gap-1.5 text-ink-2">
            <EarOff className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
              <ListenerLines reading={state} idle />
            </span>
          </span>
        ) : connection === "connected" ? (
          <NotListening urgent={isStranded(state)} />
        ) : (
          <NotConnected urgent={isStranded(state)} />
        )}
        <span className="min-w-0 truncate" title={seen ? exact(seen) : undefined}>
          {seen ? t("agents.lastActed", { when: ago(seen, now) }) : t("agents.neverActed")}
          {seen > 0 && state.last_action && <span className="ml-1 text-ink-2">{state.last_action}</span>}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        <Action member={member} state={state} app={app} busy={busy} />
      </div>
    </div>
  );
}

/** Copies `value`, and says so for a moment. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    if (!(await copyText(value))) return toast.error(t("common.copyFailed"));
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  }
  return (
    <IconButton label={done ? t("common.copied") : label} size="sm" onClick={() => void copy()}>
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </IconButton>
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
  return (
    <article
      aria-label={member.name}
      className="flex min-w-0 flex-col gap-3 border-r border-b border-line bg-surface p-4"
    >
      <header className="flex min-w-0 items-start gap-3">
        <Avatar member={member} size="lg" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-baseline gap-1.5 text-base leading-5 font-semibold">
            <Link to={`${settings}/agents/${member.handle}`} className="truncate underline-offset-2 hover:underline">
              {member.name}
            </Link>
            <span className="shrink-0 text-xs font-normal text-ink-3">@{member.handle}</span>
          </h3>
          {where && <p className="truncate text-xs text-ink-3">{where}</p>}
          {(helperNote || member.title) && (
            <p className="truncate text-xs text-ink-2">{[helperNote, member.title].filter(Boolean).join(" · ")}</p>
          )}
        </div>
        {isFinishedHelper(member) ? (
          <Badge>{t("agents.helper.finished")}</Badge>
        ) : (
          state && <AgentStateChip state={state.state} />
        )}
        <CardMenu member={member} local={local} />
      </header>

      {state && <Reach member={member} state={state} app={app} busy={!!running?.machine_id} now={now} />}

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
