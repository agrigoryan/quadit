// Rows around tasks: epics, milestones, cycles, saved views and their
// queries, watchers, inbox items, links and templates.

export interface Epic {
  id: string;
  project_id: string;
  name: string;
  description?: string;
  state: "planned" | "active" | "paused" | "done" | "canceled";
  lead_id?: string;
  color?: string;
  target_on?: string;
  rank: string;
  deleted_at?: number;
}

export interface Milestone {
  id: string;
  epic_id: string;
  name: string;
  target_on?: string;
  rank: string;
  deleted_at?: number;
}

export interface Cycle {
  id: string;
  project_id: string;
  number: number;
  name?: string;
  starts_on: string;
  ends_on: string;
  closed_at?: number;
  deleted_at?: number;
}

export interface View {
  id: string;
  project_id?: string;
  name: string;
  slug: string;
  owner_id: string;
  shared: boolean;
  query?: TaskQuery;
  layout: "list" | "board" | "timeline";
  display?: ViewDisplay;
  rank: string;
  deleted_at?: number;
}

/** The server's TaskQuery (internal/server/query.go), the part the app uses. */
export interface TaskQuery {
  project?: string[];
  assignee?: string[];
  status?: string[];
  category?: string[];
  waiting_on?: string;
  label?: string[];
  epic?: string[];
  cycle?: string[];
  priority?: number[];
  has_open_decision?: boolean;
  q?: string;
  sort?: string;
}

export type GroupBy = "status" | "assignee" | "epic" | "priority" | "none";
export type SortBy = "manual" | "priority" | "updated" | "created" | "due";

export interface ViewDisplay {
  group?: GroupBy;
  sort?: SortBy;
}

export interface Watcher {
  user_id: string;
  subject_type: string;
  subject_id: string;
  created_at: number;
}

export type NotificationType =
  | "assigned"
  | "mentioned"
  | "waiting_on"
  | "decision_asked"
  | "picked"
  | "unclear"
  | "replied"
  | "comment"
  | "result"
  | "status"
  | "budget";

export interface Notification {
  id: string;
  user_id: string;
  seq: number;
  type: NotificationType;
  actor_id: string;
  task_id?: string;
  entity_type?: string;
  entity_id?: string;
  title?: string;
  snippet?: string;
  created_at: number;
  read_at?: number;
  archived_at?: number;
}

export interface TaskLink {
  id: string;
  task_id: string;
  kind: "branch" | "commit" | "pr" | "url";
  url?: string;
  title?: string;
  repo?: string;
  ref?: string;
  state?: string;
  checks?: string;
  deleted_at?: number;
}

export interface Template {
  id: string;
  project_id?: string;
  name: string;
  title?: string;
  description?: string;
  preset?: { status?: string; priority?: number; labels?: string[]; assignee?: string; estimate?: number };
  deleted_at?: number;
}
