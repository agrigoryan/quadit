// Automation as the server sends it (internal/core/agents.go): webhooks and
// their delivery log, rules, and integrations with other services.

import type { Category, Outcome } from "@/types/core";

/** Sends the workspace's events to a URL, signed with its secret (core.Webhook). */
export type Webhook = {
  id: string;
  name: string;
  url: string;
  /** Empty means every event. */
  event_types?: string[];
  project_id?: string;
  /** Set when it only gets what lands in this member's inbox. */
  user_id?: string;
  active: boolean;
  /** Deliveries that failed in a row since the last one that worked. */
  failures: number;
  last_status?: string;
  last_at?: number;
  created_by: string;
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
};

/** One event on its way to one webhook (core.WebhookDelivery). */
export interface Delivery {
  id: string;
  webhook_id: string;
  seq: number;
  event_type: string;
  state: "pending" | "ok" | "dead";
  attempts: number;
  status_code?: number;
  error?: string;
  duration_ms?: number;
  created_at: number;
  next_at?: number;
  done_at?: number;
}

export type ActionKind = "notify" | "webhook" | "assign" | "wait_on";

/** Which events a rule fires on; an empty field matches anything (core.RuleMatch). */
export interface RuleMatch {
  event_types?: string[];
  project_id?: string;
  actor_id?: string;
  actor_kind?: "person" | "agent" | "";
  outcome?: Outcome | "";
  to_category?: Category | "";
  label_id?: string;
}

/** What a rule does (core.RuleAction). */
export interface RuleAction {
  kind: ActionKind;
  user_id?: string;
  webhook_id?: string;
  message?: string;
}

/** Does something when an event matches (core.Rule). */
export type Rule = {
  id: string;
  name: string;
  active: boolean;
  match?: RuleMatch;
  action?: RuleAction;
  created_by: string;
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
};

/** The config of a GitHub integration (core.Integration's `config`). */
export interface GitHubConfig {
  /** owner/name */
  repo?: string;
  /** GitHub Enterprise only. */
  api_url?: string;
  /** The status a task moves to: a status type (the first status of that type in the task's project), or a status's name. */
  on_open?: string;
  on_merge?: string;
  comment_back?: boolean;
  /** Issues with this label become tasks and stay in step with the issue; "*" means every issue. */
  issues_label?: string;
  /** The key of the project those tasks are made in; empty means the integration's own project. */
  issues_project?: string;
}

/** Connects the workspace, or one project, to another service (core.Integration). */
export type Integration = {
  id: string;
  kind: "github";
  name?: string;
  project_id?: string;
  config?: GitHubConfig;
  active: boolean;
  has_secret: boolean;
  last_sync_at?: number;
  last_error?: string;
  created_by: string;
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
};
