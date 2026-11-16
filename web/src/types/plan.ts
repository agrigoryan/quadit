// Rows around tasks: epics, milestones, cycles, saved views and their
// queries, watchers, inbox items, links, templates and preferences.

export type Epic = {
  id: string;
  project_id: string;
  name: string;
  description?: string;
  state: "planned" | "active" | "paused" | "done" | "canceled";
  lead_id?: string;
  color?: string;
  icon?: string;
  start_on?: string;
  target_on?: string;
  rank: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  completed_at?: number;
  updated_seq: number;
  deleted_at?: number;
};

export type Milestone = {
  id: string;
  epic_id: string;
  name: string;
  description?: string;
  target_on?: string;
  rank: string;
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
};

export type Cycle = {
  id: string;
  project_id: string;
  number: number;
  name?: string;
  starts_on: string;
  ends_on: string;
  closed_at?: number;
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
};

export type View = {
  id: string;
  project_id?: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  owner_id: string;
  shared: boolean;
  query?: TaskQuery;
  layout: "list" | "board" | "timeline";
  display?: ViewDisplay;
  rank: string;
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
};

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

export type Watcher = {
  user_id: string;
  subject_type: string;
  subject_id: string;
  created_at: number;
};

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

export type Notification = {
  id: string;
  user_id: string;
  seq: number;
  type: NotificationType;
  actor_id: string;
  task_id?: string;
  /** Set on an item about a page. */
  doc_id?: string;
  entity_type?: string;
  entity_id?: string;
  title?: string;
  snippet?: string;
  created_at: number;
  read_at?: number;
  archived_at?: number;
};

export type TaskLink = {
  id: string;
  task_id: string;
  kind: "branch" | "commit" | "pr" | "url";
  url?: string;
  title?: string;
  repo?: string;
  ref?: string;
  state?: string;
  checks?: string;
  /** What the service said of it besides, as it said it. */
  data?: unknown;
  created_by: string;
  created_at: number;
  updated_at: number;
  updated_seq: number;
  deleted_at?: number;
};

export type Template = {
  id: string;
  project_id?: string;
  name: string;
  title?: string;
  description?: string;
  preset?: { status?: string; priority?: number; labels?: string[]; assignee?: string; estimate?: number };
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
};

/** A standing rule, often made from a decision, for agents to read before they work (core.Preference). */
export type Preference = {
  id: string;
  project_id?: string;
  body: string;
  decision_id?: string;
  label_ids?: string[];
  created_by: string;
  created_at: number;
  updated_seq: number;
  retired_at?: number;
  deleted_at?: number;
};
