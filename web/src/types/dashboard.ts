// What the insight endpoints answer (internal/server/dashboard.go).

import type { Category } from "@/types/core";
import type { Preference } from "@/types/plan";

/** A task as the server lists it: names instead of ids. */
interface TaskView {
  key: string;
  title: string;
  status: string;
  category: Category;
  priority?: string;
  assignee?: string;
  waiting_on?: string;
  waiting_on_note?: string;
  epic?: string;
  due_on?: string;
}

export interface DecisionView {
  id: string;
  task?: string;
  kind: "choice" | "approval";
  question: string;
  state: "open" | "picked" | "sent_back";
  by: string;
  asked?: string;
  picked_label?: string;
  outcome?: string;
  note?: string;
  decided_by?: string;
  /** "2026-11-14 20:57", UTC. */
  decided_at?: string;
  asked_at?: string;
}

export interface EpicProgress {
  id: string;
  name: string;
  /** The project's key. */
  project: string;
  state: string;
  lead?: string;
  target_on?: string;
  total: number;
  done: number;
  started: number;
  points?: number;
  points_done?: number;
  /** Why it is at risk, in the server's words; empty when it is not. */
  at_risk?: string;
  /** The same reason as a code: past_target, due_soon, stalled. */
  at_risk_code?: string;
}

export type AgentStateName = "working" | "waiting" | "has_work" | "idle";

export interface AgentState {
  handle: string;
  name: string;
  user_id: string;
  state: AgentStateName;
  /** The key of the task it holds or runs a session on. */
  task?: string;
  doing?: string;
  /** When its running session started, "2026-11-14 20:57" UTC. */
  since?: string;
  /** Whom its work waits on, when all of it waits ("@aram"). */
  waits_on?: string;
  /** When it first proved it reached Quadit from inside its tool, "2026-11-21 14:02" UTC; missing: not connected yet. */
  connected_at?: string;
  /** One of its listeners holds its lease (`quadit wait`, `quadit listen`), or a webhook pushes to it. */
  listening: boolean;
  /** Its listeners, the one of everything first, then by project key; a project's stays when nothing holds it. */
  listeners: ListenerShown[];
  /** The projects (ids) whose items something live is handed now. */
  listening_projects: string[];
  /** Whether something live is handed the items of no project. */
  listening_outside_projects: boolean;
  /** The tool of the last connect code it gave back ("Codex"), when it has. */
  tool?: string;
  last_seen?: string;
  last_action?: string;
  open_tasks: number;
  waiting_on_it: number;
}

/**
 * One of an agent's listeners as pages are told (Go's listenerShown): of a
 * project (its id and key), or, without one, of everything else; `by`, what
 * holds it in its own words ("a chat", "a companion").
 */
export interface ListenerShown {
  project_id?: string;
  project?: string;
  by?: string;
  last_heard?: string;
  live: boolean;
  /** Set when Quadit's runner on a computer marked it as its own. */
  runner?: RunnerShown;
}

/**
 * What Quadit's runner said of itself on a listener it marked (Go's
 * runnerShown). Times are "2026-11-24 14:02", UTC.
 */
export interface RunnerShown {
  /** The computer's name, as the runner said it. */
  machine: string;
  /** The folder's label ("~/devel/game"): the path stays on the computer. */
  folder: string;
  /** core.Programs: "claude", "codex". */
  program: string;
  program_version: string;
  /** The runner holds the lease now; false while a chat holds it, or the runner is away. */
  holding: boolean;
  /** When the runner last held it. */
  since: string;
  /** Why it holds every item back (core.Pause*). */
  paused?: string;
  /** With paused "usage_limit": when it tries again. */
  paused_until?: string;
  /** The key of the task its open run is on, in this listener's project. */
  task?: string;
}

/** What will happen to a comment or an assignment for one agent (Go's runOutlook): GET /tasks/{ref}/run-outlook. */
export interface RunOutlook {
  /** "@claude". */
  agent: string;
  outcome: RunOutcome;
  machine: string;
  folder: string;
  program: string;
  /** The task's project's key. */
  project: string;
  /** The handle of the person responsible for the agent, "" without one. */
  owner: string;
  /** when_back: when its runner was last heard. */
  since: string;
  /** paused for a usage limit: when the runner tries again. */
  until: string;
  /** queued: the key of the task of the run open there, "" when items wait. */
  running: string;
  /** will_not_start: no_runner_here, not_responsible, no_responsible; paused: the pause (core.Pause*). */
  reason: string;
}

/**
 * none: Quadit does not run the agent here, or would not start it for this
 * (what the page said before); in_chat: a chat holds its listener.
 */
export type RunOutcome = "none" | "will_not_start" | "in_chat" | "when_back" | "paused" | "queued" | "starts_now";

/** How far an agent is connected: GET /agents/connection, the cheap part of GET /agents. */
export type AgentConnection = Pick<
  AgentState,
  | "handle"
  | "user_id"
  | "connected_at"
  | "listening"
  | "tool"
  | "listeners"
  | "listening_projects"
  | "listening_outside_projects"
>;

export interface StatusCount {
  status: string;
  category: Category;
  project: string;
  count: number;
}

export interface WeekCount {
  /** The Monday the week starts on. */
  week: string;
  opened: number;
  closed: number;
}

export interface WaitRow {
  member: string;
  kind: "person" | "agent";
  tasks: number;
  avg_hours: number;
  oldest_hours: number;
}

export interface Health {
  webhooks_failing?: number;
  deliveries_dead?: number;
  deliveries_pending?: number;
  sources_failing?: number;
  last_backup?: string;
  last_backup_ok?: boolean;
  /** The last backup was made, but its copy did not get where the backup setting says. */
  last_backup_copy_failed?: boolean;
}

export interface Dashboard {
  waiting_on_me: TaskView[];
  asked_of_me: DecisionView[];
  epics: EpicProgress[];
  flow: { by_status: StatusCount[]; weekly: WeekCount[]; waiting: WaitRow[] };
  agents: AgentState[];
  recent_decisions: DecisionView[];
  preferences: Preference[];
  /** Only for an admin of the whole workspace; no health is not "all well". */
  health?: Health;
}

export interface ChartDay {
  date: string;
  /** -1 for a day that has not come yet. */
  scope: number;
  done: number;
  points: number;
  points_done: number;
}

export interface CycleChart {
  days: ChartDay[];
  total: number;
  done: number;
}
