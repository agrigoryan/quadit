// The calls that read and change the rows behind the automation pages
// (their types are in lib/types-automation.ts). None of these lists is in
// the store: each page fetches its own and fetches again after a change.

import { api, workspacePath } from "@/lib/api";
import type { Changes } from "@/lib/changes.gen";
import { type ChangeSpec, type ChangeType, mutate } from "@/lib/mutate";
import type { Outcome } from "@/lib/types";
import type { ActionKind, Delivery, Webhook } from "@/lib/types-automation";

export interface TestResult {
  ok: boolean;
  /** The receiver's HTTP status; 0 when it never answered. */
  status: number;
  error: string;
  ms: number;
}

export const ACTION_KINDS: ActionKind[] = ["notify", "webhook", "assign", "wait_on"];
export const OUTCOMES: Outcome[] = ["as_is", "with_changes", "none", "approved", "declined"];

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
  /** Something the server wants said about this sync (no commits yet, no such folder). */
  note?: string;
}

/** One of the lists the server keeps for admins: webhooks, rules, integrations, deliveries. */
export async function listRows<T>(slug: string, name: string, query = ""): Promise<T[]> {
  const out = await api.get<Record<string, T[]>>(workspacePath(slug, `/list/${name}${query}`));
  return out[name] ?? [];
}

/** A webhook with the newest entry of its delivery log. A test is logged there and nowhere else. */
export type WebhookRow = Webhook & { newest?: Delivery };

export async function listWebhooks(slug: string): Promise<WebhookRow[]> {
  const hooks = await listRows<Webhook>(slug, "webhooks");
  return Promise.all(
    hooks.map(async (hook) => {
      // Without its log a webhook still shows, with what its own record says.
      const log = await listRows<Delivery>(slug, "deliveries", `?webhook=${hook.id}&limit=1`).catch(
        (): Delivery[] => [],
      );
      return { ...hook, newest: log[0] };
    }),
  );
}

/** A sample sent with the Test button, not an event from the feed: it has no place in the feed. */
export const isTest = (d: Delivery) => d.seq < 0;

/** When a webhook was last sent to and what came back: its own record, or its log when that has something newer. */
export function lastSent(hook: WebhookRow): { at: number; result: string; failed: boolean; test: boolean } | undefined {
  const d = hook.newest;
  const at = d && d.attempts > 0 ? d.done_at || d.created_at : 0;
  if (d && at > (hook.last_at ?? 0))
    return { at, result: d.error || String(d.status_code ?? ""), failed: d.state !== "ok", test: isTest(d) };
  if (!hook.last_at) return undefined;
  return { at: hook.last_at, result: hook.last_status ?? "", failed: hook.failures > 0, test: false };
}

export const listSources = (slug: string) =>
  api.get<{ sources: Source[] }>(workspacePath(slug, "/sources")).then((r) => r.sources ?? []);

/** Sends one named change. A refusal is thrown for the form to show; no toast. */
export function change<K extends ChangeType>(type: K, args: Changes[K]) {
  const spec: ChangeSpec<K> = { type, args };
  return mutate(spec, undefined, { quiet: true });
}

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
