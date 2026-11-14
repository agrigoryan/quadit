// What the insight endpoints answer (internal/server/dashboard.go), and the
// rows the store keeps untyped that these pages read.

import type { Category } from "@/lib/types";

/** A task as the server lists it: names instead of ids. */
export interface TaskView {
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
  listening: boolean;
  last_seen?: string;
  last_action?: string;
  open_tasks: number;
  waiting_on_it: number;
  /** Dollars this week as a decimal string; absent when nothing was spent. */
  cost_week?: string;
  minutes_week?: number;
  budget?: string;
}

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
}

export interface Preference {
  id: string;
  project_id?: string;
  body: string;
  decision_id?: string;
  label_ids?: string[];
  created_by: string;
  created_at: number;
  retired_at?: number;
  deleted_at?: number;
}

export interface Dashboard {
  waiting_on_me: TaskView[];
  asked_of_me: DecisionView[];
  epics: EpicProgress[];
  flow: { by_status: StatusCount[]; weekly: WeekCount[]; waiting: WaitRow[] };
  agents: AgentState[];
  recent_decisions: DecisionView[];
  preferences: Preference[];
  health: Health;
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

/** A shared machine or device agents take turns on. */
export interface Resource {
  id: string;
  name: string;
  description?: string;
  deleted_at?: number;
}

/** One place in a resource's queue. A released claim stays in the store; skip it. */
export interface Claim {
  id: string;
  resource_id: string;
  user_id: string;
  task_id?: string;
  note?: string;
  state: "holding" | "waiting" | "released";
  requested_at: number;
  acquired_at?: number;
  /** While holding: when the hold ends. While waiting: the minutes asked for. */
  lease_until?: number;
}
