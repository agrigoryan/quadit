// What the desktop app's own windows (its menu-bar panel, quick capture,
// Connect) are told about the workspace this window shows: what waits on me
// (the questions asked of me with a button per option, the tasks that wait
// on me, the runs of my agents that failed or did not start), the runs open
// now with Stop where I may stop them, the agents with the first line of
// their card, and the projects a task can be made in. Each list is short
// (at most 10, and how many more). The app counts what waits on me for its
// menu-bar number, and holds the summary only while this window shows the
// workspace.

import { useEffect, useMemo, useRef } from "react";
import { type Access, can } from "@/data/access";
import { connectionOf, useAgentStates } from "@/data/listening";
import type { AgentState } from "@/types/dashboard";
import { useLookup, useMe, useOpenDecisions, useProjects, useRows, useSlug } from "@/data/selectors";
import { useStore } from "@/data/store";
import { useMinute } from "@/hooks/tick";
import { isKey, t, tMaybe } from "@/lib/i18n";
import { exact, parseWhen } from "@/lib/time";
import { taskPath } from "@/nav/task-link";
import { pickAction } from "@/shell/desktop-requests";
import {
  type AgentSession,
  type Decision,
  isOpenCategory,
  isOpenSession,
  type Member,
  type Project,
  type Task,
} from "@/types/core";
import type { DesktopAction, DesktopSummary, SummaryList } from "@/types/desktop";
import { type LocalAgent, useLocalAgents } from "@/ui/desktop-agents";

const LIST_MAX = 10;
const ACTIONS_MAX = 6;
const AGENTS_MAX = 50;
const PROJECTS_MAX = 200;
/** How long a run that failed or did not start is said to need its agent's person. */
const RUN_NEEDS_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

/**
 * Keeps the desktop app told about this window's workspace, for as long as
 * the shell is on screen. Only in the app: it reads what the agents are
 * doing from the server, which a browser has no use for.
 */
export function useDesktopSummary() {
  const summary = useSummary();
  // Most edits to the copy change nothing the app is told: it is told again only when what it holds would change.
  const told = useRef("");

  useEffect(() => {
    const text = JSON.stringify(summary);
    if (!summary || text === told.current) return;
    told.current = text;
    window.quaditDesktop?.publish?.(summary);
  }, [summary]);

  // The shell going (signing out, say) takes the summary back; another workspace replaces it.
  useEffect(() => {
    const desktop = window.quaditDesktop;
    return () => desktop?.publish?.(null);
  }, []);
}

/** The summary of the open workspace, or null until its copy is loaded. */
export function useSummary(): DesktopSummary | null {
  const workspace = useStore((s) => s.workspace);
  const slug = useSlug();
  const me = useMe();
  const openDecisions = useOpenDecisions();
  const tasks = useLookup("tasks");
  const statuses = useLookup("statuses");
  const members = useLookup("members");
  const projects = useProjects();
  const sessions = useRows("sessions");
  const states = useAgentStates().data;
  const local = useLocalAgents();
  const minute = useMinute();

  return useMemo(() => {
    if (!workspace) return null;
    const access = can(me);
    const now = minute * MINUTE_MS;
    const open = (task: Task | undefined) => !!task && isOpenCategory(statuses[task.status_id]?.category);
    const path = (task: Task) => taskPath(slug, task.key);

    const decisions = Object.values(openDecisions).flat();
    const asked = decisions
      .filter((d) => d.asked_id === me.user_id && tasks[d.task_id])
      .sort((a, b) => b.created_at - a.created_at);
    const waiting = asked.slice(0, LIST_MAX).map((decision) => {
      const task = tasks[decision.task_id];
      return {
        title: decision.question,
        detail: task ? `${task.key} ${task.title}` : "",
        path: task ? `${taskPath(slug, task.key)}#decision-${decision.id}` : `/${slug}`,
        actions: (decision.options ?? []).slice(0, ACTIONS_MAX).map((option) => pickAction(decision, option)),
      };
    });

    // A task with a question asked of me is said once, by its question.
    const askedOn = new Set(asked.map((d) => d.task_id));
    const waitsOnMe = Object.values(tasks)
      .filter((task) => task.waiting_on_id === me.user_id && open(task) && !askedOn.has(task.id))
      .sort((a, b) => b.updated_seq - a.updated_seq)
      .map((task) => ({
        key: task.key,
        title: task.title,
        who: task.assignee_id ? `@${members[task.assignee_id]?.handle ?? ""}` : "",
        path: path(task),
      }));

    const runs = runsNeeding(sessions, { me, members, tasks, now }).map(({ session, task }) => ({
      key: task.key,
      title: task.title,
      line: runLine(session, members),
      path: path(task),
    }));

    const working = runsOpen(sessions, decisions, tasks).map(({ session, task, awaiting }) => {
      const agent = members[session.agent_id];
      return {
        agent: agent ? `@${agent.handle}` : t("common.agent"),
        key: task.key,
        title: task.title,
        state: t(`agents.session.${awaiting ? "awaiting" : session.state}`),
        since: session.started_at,
        path: path(task),
        ...(mayStop(session, task, access) ? { stop: stopAction(session) } : {}),
      };
    });

    // A new member is available to Connect before the throttled activity read catches up.
    const agents = Object.values(members)
      .filter((member) => member.kind === "agent" && !member.suspended_at)
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .slice(0, AGENTS_MAX)
      .map((member) => {
        const state = states?.[member.user_id];
        const shown = cardLine(member, state, local?.[member.user_id], projects);
        return {
          id: member.user_id,
          handle: member.handle,
          name: member.name,
          state: state?.state ?? "idle",
          detail: state ? detailOf(state) : "",
          path: state?.state === "working" && state.task ? taskPath(slug, state.task) : `/${slug}/agents`,
          usable: access.administer || member.responsible_id === me.user_id,
          ...(shown ? { line: shown.line, reach: shown.reach } : {}),
        };
      });

    return {
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      me: { name: me.name, canCreateAgents: access.administer },
      waiting,
      waitingMore: Math.max(asked.length - LIST_MAX, 0),
      tasks: listOf(waitsOnMe),
      runs: listOf(runs),
      working: listOf(working),
      agents,
      projects: projects
        .filter((p) => access.edit(p.id))
        .slice(0, PROJECTS_MAX)
        .map((p) => ({ key: p.key, name: p.name })),
    };
  }, [workspace, slug, me, openDecisions, tasks, statuses, members, projects, sessions, states, local, minute]);
}

/** The first LIST_MAX of `items`, and how many more. */
function listOf<T>(items: T[]): SummaryList<T> {
  return { items: items.slice(0, LIST_MAX), more: Math.max(items.length - LIST_MAX, 0) };
}

/**
 * The runs of agents `me` answers for that Quadit's runner could not start
 * or that failed, in the last day, each the newest of its agent on its task
 * (a newer one replaced it otherwise), newest first.
 */
function runsNeeding(
  sessions: readonly AgentSession[],
  {
    me,
    members,
    tasks,
    now,
  }: { me: Member; members: Record<string, Member>; tasks: Record<string, Task>; now: number },
): { session: AgentSession; task: Task }[] {
  const newest = new Map<string, AgentSession>();
  for (const session of sessions) {
    const key = `${session.agent_id}\n${session.task_id ?? ""}`;
    if ((newest.get(key)?.started_at ?? -1) < session.started_at) newest.set(key, session);
  }
  return [...newest.values()]
    .filter(
      (s) =>
        !!s.machine_id &&
        (s.state === "failed" || s.state === "not_started") &&
        now - (s.ended_at ?? s.started_at) < RUN_NEEDS_MS &&
        members[s.agent_id]?.responsible_id === me.user_id,
    )
    .sort((a, b) => (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at))
    .flatMap((session) => {
      const task = session.task_id ? tasks[session.task_id] : undefined;
      return task ? [{ session, task }] : [];
    });
}

/**
 * The runs open now, longest running first: waiting or working, and a run
 * done whose agent asked a question on its task since, which waits for an
 * answer (as the task's Sessions say it).
 */
function runsOpen(
  sessions: readonly AgentSession[],
  decisions: readonly Decision[],
  tasks: Record<string, Task>,
): { session: AgentSession; task: Task; awaiting: boolean }[] {
  const newestDone = new Map<string, AgentSession>();
  for (const session of sessions) {
    if (session.state !== "done" || !session.machine_id) continue;
    const key = `${session.agent_id}\n${session.task_id ?? ""}`;
    if ((newestDone.get(key)?.started_at ?? -1) < session.started_at) newestDone.set(key, session);
  }
  const asking = new Set(decisions.map((d) => `${d.created_by}\n${d.task_id}`));
  return [
    ...sessions.filter(isOpenSession).map((session) => ({ session, awaiting: false })),
    ...[...newestDone]
      .filter(([key]) => asking.has(key))
      .filter(
        ([, done]) =>
          !sessions.some((s) => isOpenSession(s) && s.agent_id === done.agent_id && s.task_id === done.task_id),
      )
      .map(([, session]) => ({ session, awaiting: true })),
  ]
    .sort((a, b) => a.session.started_at - b.session.started_at)
    .flatMap(({ session, awaiting }) => {
      const task = session.task_id ? tasks[session.task_id] : undefined;
      return task ? [{ session, task, awaiting }] : [];
    });
}

/** Whether `me` may stop a run: the rule of the task page's Stop (StopRun), a runner's open run on a task they may change. */
function mayStop(session: AgentSession, task: Task, access: Access): boolean {
  return !!session.machine_id && isOpenSession(session) && !session.stop_requested_at && access.editTask(task);
}

/** The button that asks a run to stop; the page carries it out (desktop-requests.ts, act). */
const stopAction = (session: AgentSession): DesktopAction => ({
  label: t("agents.session.stop"),
  request: `stop:${session.id}`,
});

/** A run's own line on the task's Sessions: why it did not start or failed, and what to do; else its state's word. */
function runLine(session: AgentSession, members: Record<string, Member>): string {
  const agent = members[session.agent_id];
  const owner = agent?.responsible_id ? members[agent.responsible_id] : undefined;
  const words = {
    agent: agent ? `@${agent.handle}` : t("common.agent"),
    owner: owner?.name ?? t("common.someone"),
    machine: session.machine_name ?? "",
    program: tMaybe(`run.program.${session.program ?? ""}`, session.program ?? ""),
    time: session.resets_at ? exact(session.resets_at) : "",
  };
  const code = session.reason ?? "";
  const reason = `agents.run.reason.${code}`;
  const todo =
    code === "usage_limit" && !session.resets_at ? "agents.run.todo.usage_limitUnknown" : `agents.run.todo.${code}`;
  if (!isKey(reason)) return t(`agents.session.${session.state}`);
  return isKey(todo) ? `${t(reason, words)} ${t(todo, words)}` : t(reason, words);
}

type Tone = "ok" | "work" | "wait" | "quiet";

/**
 * The first line of an agent's card on the Agents page, in its words and
 * colour (insights/agents/agent-reach.tsx, Hearing), and how far it is
 * heard; none before the server has said what hears it.
 */
function cardLine(
  member: Member,
  state: AgentState | undefined,
  local: LocalAgent | undefined,
  projects: readonly Project[],
): { line: { text: string; tone: Tone }; reach: "not_connected" | "not_listening" | "heard" } | undefined {
  if (connectionOf(member, state) === "not_connected")
    return { line: { text: t("agents.card.notConnected"), tone: "quiet" }, reach: "not_connected" };
  if (!state) return undefined;
  const heard = (text: string, tone: Tone = "ok") => ({ line: { text, tone }, reach: "heard" as const });
  const ownProjects = state.listeners.some((l) => l.project_id);
  for (const l of state.listeners) {
    const project = l.project ?? "";
    if (l.runner) {
      const { runner } = l;
      if (!l.live)
        return heard(
          t("agents.runner.away", { project, machine: runner.machine, time: exact(parseWhen(runner.since)) }),
          "quiet",
        );
      if (!l.project_id || !local?.runs.includes(l.project_id))
        return heard(t("agents.card.runsElsewhere", { project, machine: runner.machine }));
      const program = state.tool || local.programName || tMaybe(`run.program.${runner.program}`, runner.program);
      const status = runnerWords(runner, l.live, project, program);
      return heard(`${t("agents.card.runs", { project, folder: runner.folder })} ${status.text}`, status.tone);
    }
    if (!l.live) continue;
    const what = l.project_id
      ? (projects.find((p) => p.id === l.project_id)?.name ?? project)
      : t(ownProjects ? "agents.listener.everythingElse" : "agents.listener.everything");
    return heard(l.by ? t("agents.listener.toFrom", { what, by: l.by }) : t("agents.listener.to", { what }));
  }
  if (state.listening_outside_projects) return heard(t("agents.listener.webhook"));
  if (state.listening) return heard(t("agents.card.listening"));
  return { line: { text: t("agents.card.notListening"), tone: "wait" }, reach: "not_listening" };
}

/** A Quadit runner's status on this computer, in the card's words: a chat holds it, paused and why, working, or ready. */
function runnerWords(
  runner: NonNullable<AgentState["listeners"][number]["runner"]>,
  live: boolean,
  project: string,
  program: string,
): { text: string; tone: Tone } {
  if (live && !runner.holding) return { text: t("agents.card.aside", { project }), tone: "wait" };
  if (runner.paused) {
    const until = parseWhen(runner.paused_until);
    const key =
      runner.paused === "usage_limit" && !until
        ? "agents.card.paused.usage_limitUnknown"
        : `agents.card.paused.${runner.paused}`;
    const words = { program, machine: runner.machine, time: until ? exact(until) : "" };
    return { text: t(isKey(key) ? key : "agents.card.paused.other", words), tone: "wait" };
  }
  if (runner.task) return { text: t("agents.card.working", { task: runner.task }), tone: "work" };
  return { text: t("agents.card.ready"), tone: "ok" };
}

/** One line of plain words for what an agent is doing, as the dashboard says it. */
function detailOf(agent: AgentState): string {
  switch (agent.state) {
    case "working":
      return [agent.task, agent.doing].filter(Boolean).join(" ");
    case "waiting":
      return t("dash.agents.waitsOn", { who: agent.waits_on ?? "" });
    case "has_work":
      return t("dash.agents.queue", { n: agent.waiting_on_it });
    case "idle":
      return agent.open_tasks > 0 ? t("dash.agents.open", { n: agent.open_tasks }) : t("dash.agents.nothing");
  }
}
