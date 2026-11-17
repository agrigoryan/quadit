// The feed: events as the server sends them, and what a write answers with.

import type { Attachment } from "@/types/core";

/** One accepted change from the feed. */
export interface FeedEvent {
  seq: number;
  at: number;
  actor_id: string;
  change_id: string;
  type: string;
  entity_type: string;
  entity_id: string;
  scope_type: string;
  scope_id: string;
  project_id?: string;
  audience_id?: string;
  data: EventData;
}

export interface FieldChange {
  from: unknown;
  to: unknown;
}

interface EventData {
  row?: Record<string, unknown>;
  changes?: Record<string, FieldChange>;
  ids?: string[];
  gone?: boolean;
  attachments?: Attachment[];
  key?: string;
  user_id?: string;
  [extra: string]: unknown;
}

export interface ChangeResult {
  change_id: string;
  type: string;
  seq: number;
  /** The feed position of the change's first event. */
  first_seq: number;
  ref?: string;
  key?: string;
  duplicate?: boolean;
  events?: FeedEvent[];
  /** What the change did that its sender may not have meant, such as taking out the words a comment thread was on. */
  warnings?: string[];
}

export interface SearchHit {
  kind: string;
  entity_id: string;
  scope_type: string;
  scope_id: string;
  /** The project of what was found: a task's, or the one a page is tied to. */
  project_id?: string;
  title: string;
  snippet: string;
  task?: string;
  url: string;
}
