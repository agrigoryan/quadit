// The rows behind the automation pages, as the server sends them, and the
// calls that read and change them. None of these lists is in the store:
// each page fetches its own and fetches again after a change.

import { api, ws } from "@/lib/api";
import { mutate } from "@/lib/mutate";
import type { Category, Outcome } from "@/lib/types";

export interface Webhook {
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
  created_at: number;
}

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

export interface TestResult {
  ok: boolean;
  /** The receiver's HTTP status; 0 when it never answered. */
  status: number;
  error: string;
  ms: number;
}

export type ActionKind = "notify" | "webhook" | "assign" | "wait_on";
export const ACTION_KINDS: ActionKind[] = ["notify", "webhook", "assign", "wait_on"];
export const OUTCOMES: Outcome[] = ["as_is", "with_changes", "none", "approved", "declined"];

export interface RuleMatch {
  event_types?: string[];
  project_id?: string;
  actor_id?: string;
  actor_kind?: "person" | "agent" | "";
  outcome?: Outcome | "";
  to_category?: Category | "";
  label_id?: string;
}

export interface RuleAction {
  kind: ActionKind;
  user_id?: string;
  webhook_id?: string;
  message?: string;
}

export interface Rule {
  id: string;
  name: string;
  active: boolean;
  match?: RuleMatch;
  action?: RuleAction;
  created_at: number;
}

export interface GitHubConfig {
  /** owner/name */
  repo?: string;
  /** GitHub Enterprise only. */
  api_url?: string;
  on_open?: Category | "";
  on_merge?: Category | "";
  comment_back?: boolean;
  /** Issues with this label become tasks and stay in step with the issue; "*" means every issue. */
  issues_label?: string;
  /** The key of the project those tasks are made in; empty means the integration's own project. */
  issues_project?: string;
}

export interface Integration {
  id: string;
  kind: "github";
  name?: string;
  project_id?: string;
  config?: GitHubConfig;
  active: boolean;
  has_secret: boolean;
  last_sync_at?: number;
  last_error?: string;
  created_at: number;
}

export interface HookInfo {
  url: string;
  secret: string;
  content_type: string;
  events: string[];
}

export type Authority = "repo" | "pages";
export type WriteMode = "commit" | "propose" | "none";

export interface Source {
  id: string;
  root_doc_id: string;
  repo: string;
  branch?: string;
  subdir?: string;
  authority: Authority;
  write_mode: WriteMode;
  last_commit?: string;
  last_sync_at?: number;
  last_error?: string;
  created_at: number;
}

export interface SyncResult {
  pages_updated: number;
  pages_created: number;
  pages_trashed: number;
  files_written: number;
  commit: string;
  pushed?: string;
}

/** One of the lists the server keeps for admins: webhooks, rules, integrations, deliveries. */
export async function listRows<T>(slug: string, name: string, query = ""): Promise<T[]> {
  const out = await api.get<Record<string, T[]>>(ws(slug, `/list/${name}${query}`));
  return out[name] ?? [];
}

export const listSources = (slug: string) => api.get<{ sources: Source[] }>(ws(slug, "/sources")).then((r) => r.sources ?? []);

/** Sends one named change. A refusal is thrown for the form to show; no toast. */
export const change = (type: string, args: Record<string, unknown>) => mutate({ type, args }, undefined, { quiet: true });

/** A signing secret made in the browser, so it can be shown once: 32 random bytes as base64url. */
export function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The event types offered first, by family. The server takes any
// "entity.verb" and "entity.*"; these are the ones a receiver most often
// wants. The whole list comes from the server (see useEventTypes).
export const EVENT_GROUPS: { id: string; types: string[] }[] = [
  { id: "task", types: ["task.created", "task.updated", "task.restored"] },
  { id: "decision", types: ["decision.opened", "decision.picked", "decision.unclear"] },
  { id: "comment", types: ["comment.created", "comment.updated"] },
  { id: "link", types: ["attachment.created", "link.created", "link.updated"] },
  { id: "session", types: ["session.created", "session.updated"] },
  { id: "doc", types: ["doc.created", "doc.edited"] },
];

/** What is offered when the server's list cannot be had. */
export const FALLBACK_EVENTS = EVENT_GROUPS.flatMap((g) => g.types);

let eventTypes: Promise<string[]> | null = null;

/** Every event type the server's feed carries. Asked for once; the fallback list if that fails. */
export function loadEventTypes(): Promise<string[]> {
  eventTypes ??= api
    .get<{ types?: string[] }>("/api/v1/events/types")
    .then((r) => (r.types?.length ? r.types : FALLBACK_EVENTS))
    .catch(() => {
      eventTypes = null; // ask again next time
      return FALLBACK_EVENTS;
    });
  return eventTypes;
}

/** Whether a list of patterns lets an event type through, the way the server decides it. */
export function typeMatches(patterns: string[] | undefined, type: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => p === type || p === "*" || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));
}
