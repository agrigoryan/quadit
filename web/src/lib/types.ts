// The rows the server sends, as they are on the wire (internal/core/*.go).
// Ids are UUIDv7 strings, times are Unix milliseconds, dates are YYYY-MM-DD,
// and an empty optional field is left out.

export type Category = "backlog" | "unstarted" | "started" | "waiting" | "done" | "canceled";
export const CATEGORIES: Category[] = ["backlog", "unstarted", "started", "waiting", "done", "canceled"];
export const isOpenCategory = (c: Category | undefined) => c !== "done" && c !== "canceled";

export type Role = "owner" | "admin" | "member";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  seq: number;
}

export interface User {
  id: string;
  kind: "person" | "agent";
  name: string;
  email?: string;
  avatar?: string;
  theme?: string;
  locale?: string;
  is_admin?: boolean;
}

export interface Member {
  workspace_id: string;
  user_id: string;
  role: Role;
  handle: string;
  kind: "person" | "agent";
  name: string;
  avatar?: string;
  title?: string;
  /** For an agent: the person who answers for it. */
  responsible_id?: string;
  budget?: { cost_micros?: number; minutes?: number };
  last_action?: string;
  last_seen_at?: number;
  listening_until?: number;
  suspended_at?: number;
  removed_at?: number;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  lead_id?: string;
  rank?: string;
  settings?: { cycles?: boolean; cycle_days?: number; estimates?: boolean };
  archived_at?: number;
  deleted_at?: number;
}

export interface Status {
  id: string;
  project_id: string;
  name: string;
  color?: string;
  category: Category;
  rank: string;
  is_default?: boolean;
  deleted_at?: number;
}

export interface Label {
  id: string;
  project_id?: string;
  name: string;
  color?: string;
  deleted_at?: number;
}

export interface Task {
  id: string;
  project_id: string;
  number: number;
  key: string;
  title: string;
  description?: string;
  status_id: string;
  priority: number;
  assignee_id?: string;
  waiting_on_id?: string;
  waiting_on_note?: string;
  parent_id?: string;
  epic_id?: string;
  milestone_id?: string;
  cycle_id?: string;
  estimate?: number;
  label_ids?: string[];
  lease_holder_id?: string;
  lease_until?: number;
  /** The person who gave the task to an agent; the agent works with no more access than they have. */
  asked_by?: string;
  rank: string;
  due_on?: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at?: number;
  completed_at?: number;
  canceled_at?: number;
  updated_seq: number;
  archived_at?: number;
  deleted_at?: number;
}

export interface Relation {
  id: string;
  task_id: string;
  related_task_id: string;
  type: "blocks" | "relates" | "duplicates";
  created_by: string;
  created_at: number;
}

export type SubjectType = "task" | "comment" | "decision" | "decision_option" | "doc" | "doc_block";

export interface Comment {
  id: string;
  task_id?: string;
  subject_type: SubjectType;
  subject_id: string;
  kind: "comment" | "result";
  evidence?: { checked?: string; measured?: string; not_verified?: string };
  parent_id?: string;
  author_id: string;
  body: string;
  created_at: number;
  edited_at?: number;
  deleted_at?: number;
}

export type Outcome = "as_is" | "with_changes" | "none" | "approved" | "declined";

export interface DecisionOption {
  id: string;
  decision_id: string;
  label: string;
  description?: string;
  rank: string;
}

export interface Decision {
  id: string;
  task_id: string;
  kind: "choice" | "approval";
  question: string;
  details?: string;
  action?: string;
  state: "open" | "picked" | "sent_back";
  asked_id?: string;
  unclear_note?: string;
  recommended_option_id?: string;
  recommendation?: string;
  picked_option_id?: string;
  outcome?: Outcome;
  outcome_note?: string;
  decided_by?: string;
  decided_at?: number;
  rank: string;
  created_by: string;
  created_at: number;
  deleted_at?: number;
  options?: DecisionOption[];
}

export interface FileRow {
  id: string;
  name: string;
  content_type: string;
  size: number;
  state: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  url: string;
  preview_url?: string;
}

export interface Attachment {
  id: string;
  file_id: string;
  subject_type: SubjectType;
  subject_id: string;
  task_id?: string;
  role?: string;
  caption?: string;
  rank: string;
  created_by: string;
  created_at: number;
  deleted_at?: number;
  file?: FileRow;
}

export interface AgentSession {
  id: string;
  agent_id: string;
  task_id?: string;
  title?: string;
  state: string;
  summary?: string;
  instructions?: string;
  /** What the run did, in order; each step is whatever the agent recorded. */
  steps?: unknown[];
  links?: unknown[];
  cost_micros?: number;
  tokens_in?: number;
  tokens_out?: number;
  started_at: number;
  ended_at?: number;
}

/** A key or password agents can use but never read. Its value is never sent to the browser. */
export interface Secret {
  id: string;
  name: string;
  description?: string;
  /** Where a request with it may go: "api.example.com", "*.example.com", "http://host:port". */
  hosts?: string[];
  /** User ids of the members that may use it; none means every member. */
  agents?: string[];
  /** A companion may put the value in the environment of a command it runs. */
  env: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_used_at?: number;
  deleted_at?: number;
}

export * from "@/lib/types-feed";
export * from "@/lib/types-plan";
