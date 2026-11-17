// The rows the server sends, as they are on the wire (internal/core/*.go).
// Ids are UUIDv7 strings, times are Unix milliseconds, dates are YYYY-MM-DD,
// and an empty optional field is left out.
//
// The types folder: what crosses the wire, declared once and named after
// the Go type it mirrors. This file holds the rows every part of the app
// meets (workspace, members, projects, statuses, tasks, comments,
// decisions, files); feed.ts, plan.ts, docs.ts, agents.ts and automation.ts
// hold the rest by topic, and changes.gen.ts, generated from the server,
// holds the arguments of every change. rows.gen.ts, also generated, is the
// server's rows, which rows.check.ts holds these types to: a field the
// server adds or changes fails the type check until it is written here.
// Nothing here imports from outside this folder.

export type Category = "backlog" | "unstarted" | "started" | "waiting" | "done" | "canceled";
export const CATEGORIES: Category[] = ["backlog", "unstarted", "started", "waiting", "done", "canceled"];
export const isOpenCategory = (c: Category | undefined) => c !== "done" && c !== "canceled";
/** A task in a status of this category is finished, one way or the other. */
export const isClosedCategory = (c: Category | undefined) => !isOpenCategory(c);
/** A task in a status of this category was done; a canceled one was not. */
export const isDoneCategory = (c: Category | undefined) => c === "done";
/** A task in a status of this category was dropped: it counts as neither work left nor work done. */
export const isCanceledCategory = (c: Category | undefined) => c === "canceled";

export type Role = "owner" | "admin" | "member";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  seq: number;
  /** The workspace's own settings, as an admin set them. */
  settings?: Record<string, unknown>;
  created_at: number;
}

export type EmailChoice = "all" | "important" | "none";

/** Which notices a person wants (core.User's `notify`). */
export interface NotifyPrefs {
  /** Missing means "important". */
  email?: EmailChoice;
  /** Missing means on. */
  push?: boolean;
}

export interface User {
  id: string;
  kind: "person" | "agent";
  name: string;
  email?: string;
  avatar?: string;
  description?: string;
  timezone?: string;
  theme?: string;
  locale?: string;
  /** When two-step sign-in was turned on; missing when it is off. */
  totp_at?: number;
  is_admin?: boolean;
  notify?: NotifyPrefs;
  /** An agent's: the workspace it belongs to, the person who answers for it, and who made it. */
  workspace_id?: string;
  responsible_id?: string;
  created_by?: string;
  created_at: number;
  last_seen_at?: number;
  disabled_at?: number;
}

export type Member = {
  workspace_id: string;
  user_id: string;
  role: Role;
  handle: string;
  kind: "person" | "agent";
  name: string;
  /** Given to admins only. */
  email?: string;
  avatar?: string;
  title?: string;
  /** For an agent: the person who answers for it. */
  responsible_id?: string;
  /** For an agent: how many times a week it may pass work on to another agent; absent is no limit. */
  handoff_limit?: number;
  /** `projects`: the member sees only these (ids). `read_only`: it may look but change nothing. */
  scope?: { projects?: string[]; read_only?: boolean };
  /** A helper agent made for one task: the user id of its maker, and the task. It is suspended when the task closes. */
  delegated_by?: string;
  delegated_task?: string;
  last_action?: string;
  last_seen_at?: number;
  listening_until?: number;
  created_at: number;
  updated_seq: number;
  suspended_at?: number;
  removed_at?: number;
};

export type Project = {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  lead_id?: string;
  rank?: string;
  settings?: { cycles?: boolean; cycle_days?: number; estimates?: boolean };
  created_by: string;
  created_at: number;
  updated_seq: number;
  archived_at?: number;
  deleted_at?: number;
};

export type Status = {
  id: string;
  project_id: string;
  name: string;
  color?: string;
  category: Category;
  rank: string;
  is_default?: boolean;
  updated_seq: number;
  deleted_at?: number;
};

export type Label = {
  id: string;
  project_id?: string;
  name: string;
  description?: string;
  color?: string;
  updated_seq: number;
  deleted_at?: number;
};

export type Task = {
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
  /** The next move is nobody's here: the task waits on an outside event, which the note names. */
  waiting_outside?: boolean;
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
  /** How many times the task may pass from agent to agent in all; absent is no limit. */
  handoff_limit?: number;
  rank: string;
  due_on?: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at?: number;
  completed_at?: number;
  canceled_at?: number;
  created_seq: number;
  updated_seq: number;
  /** The last change to it or to anything on it (a comment, a decision, a file). */
  activity_seq: number;
  archived_at?: number;
  deleted_at?: number;
};

/** One end's id is "" when it is a task of a project the reader may not read. */
export type Relation = {
  id: string;
  task_id: string;
  related_task_id: string;
  type: "blocks" | "relates" | "duplicates";
  created_by: string;
  created_at: number;
};

export type SubjectType = "task" | "comment" | "decision" | "decision_option" | "doc" | "doc_block";

export type Comment = {
  id: string;
  task_id?: string;
  /** Set on a comment on a page or one of its blocks. */
  doc_id?: string;
  subject_type: SubjectType;
  subject_id: string;
  kind: "comment" | "result";
  evidence?: { checked?: string; measured?: string; not_verified?: string };
  /** A page comment's thread was closed. */
  resolved_at?: number;
  parent_id?: string;
  author_id: string;
  body: string;
  /** The words of a page a thread was started on; they carry its marker in the page's text. */
  quote?: string;
  /** When an edit took the thread's words out of the page: it is then on the page as a whole. */
  detached_at?: number;
  created_at: number;
  edited_at?: number;
  /** The feed position at which it was written, and at which it last changed. */
  created_seq: number;
  updated_seq: number;
  deleted_at?: number;
};

export type Outcome = "as_is" | "with_changes" | "none" | "approved" | "declined";

export interface DecisionOption {
  id: string;
  decision_id: string;
  label: string;
  description?: string;
  rank: string;
}

export type Decision = {
  id: string;
  task_id: string;
  kind: "choice" | "approval";
  question: string;
  details?: string;
  action?: string;
  /** The arguments of the change an approval is for; the approval covers that change and no other. */
  action_args?: Record<string, unknown>;
  /** When the approved change ran. */
  action_used_at?: number;
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
  updated_at: number;
  updated_seq: number;
  deleted_at?: number;
  options?: DecisionOption[];
};

export interface FileRow {
  id: string;
  name: string;
  content_type: string;
  size: number;
  /** Bytes received so far, while it is being uploaded. */
  received?: number;
  sha256?: string;
  state: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  uploaded_by: string;
  created_at: number;
  deleted_at?: number;
  url: string;
  preview_url?: string;
}

export type Attachment = {
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
};

export type AgentSession = {
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
  started_at: number;
  ended_at?: number;
  updated_seq: number;
};

/** A key or password agents can use but never read. Its value is never sent to the browser. */
export type Secret = {
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
  updated_seq: number;
  deleted_at?: number;
};

export * from "@/types/feed";
export * from "@/types/plan";
