// How rows get into the collections: which collection a kind of row lives
// in, what its key is, and how one feed event changes the copy.

import type { CollectionName, Collections, Dict } from "@/lib/store";
import type { FeedEvent } from "@/lib/types";
import { localPath } from "@/lib/url";

export type AnyRow = Record<string, unknown>;

/** Which collection an event's entity_type lives in. */
const COLLECTION_OF: Record<string, CollectionName> = {
  task: "tasks",
  comment: "comments",
  decision: "decisions",
  project: "projects",
  status: "statuses",
  label: "labels",
  member: "members",
  epic: "epics",
  milestone: "milestones",
  cycle: "cycles",
  view: "views",
  template: "templates",
  preference: "preferences",
  attachment: "attachments",
  relation: "relations",
  link: "links",
  notification: "notifications",
  watcher: "watchers",
  session: "sessions",
  resource: "resources",
  claim: "claims",
  doc: "docs",
  block: "blocks",
  webhook: "webhooks",
  rule: "rules",
  integration: "integrations",
  secret: "secrets",
};

export const emptyCollections = (): Collections => {
  const c = {} as Record<CollectionName, Dict<never>>;
  for (const name of new Set(Object.values(COLLECTION_OF))) c[name] = {};
  return c;
};

/** Members are keyed by user id; a watcher has no id of its own. */
export function keyOf(collection: CollectionName, row: AnyRow): string {
  if (collection === "members") return String(row.user_id);
  if (collection === "watchers") return `${String(row.user_id)}:${String(row.subject_id)}`;
  return String(row.id);
}

export function normalize(collection: CollectionName, row: AnyRow): AnyRow {
  if (collection !== "attachments" || !row.file) return row;
  const file = row.file as AnyRow;
  // A file inside a feed event comes without its address; it is always /f/<id>/<name>.
  const url = (file.url as string | undefined) ?? `/f/${String(file.id)}/${encodeURIComponent(String(file.name))}`;
  return {
    ...row,
    file: { ...file, url: localPath(url), preview_url: localPath(file.preview_url as string | undefined) },
  };
}

/** Copy-on-write over the collections: only tables that change are copied. */
export class CopyOnWrite {
  private next: Partial<Record<CollectionName, Dict<AnyRow>>> = {};
  constructor(private base: Collections) {}

  table(name: CollectionName): Dict<AnyRow> {
    return (this.next[name] ??= { ...(this.base[name] as Dict<AnyRow>) });
  }
  peek(name: CollectionName): Dict<AnyRow> {
    return this.next[name] ?? (this.base[name] as Dict<AnyRow>);
  }
  put(name: CollectionName, row: AnyRow) {
    this.table(name)[keyOf(name, row)] = normalize(name, row);
  }
  patch(name: CollectionName, id: string, fields: AnyRow) {
    const cur = this.peek(name)[id];
    if (!cur) return;
    const row = { ...cur };
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === undefined) delete row[field];
      else row[field] = value;
    }
    this.table(name)[id] = row;
  }
  drop(name: CollectionName, id: string) {
    if (id in this.peek(name)) delete this.table(name)[id];
  }
  done(): Collections {
    return { ...this.base, ...this.next } as Collections;
  }
}

/** Collections whose rows carry `updated_seq`, the position of their last change, and come in the starting copy's second part. */
const TRACKED: ReadonlySet<CollectionName> = new Set<CollectionName>(["tasks", "decisions"]);

/**
 * Applies one feed event to the draft. Applying an event twice is harmless.
 * With `only`, the event touches just the rows it names (used to replay
 * events over rows that arrived after them).
 */
export function applyEvent(d: CopyOnWrite, ev: FeedEvent, only?: (collection: CollectionName, key: string) => boolean) {
  const name = COLLECTION_OF[ev.entity_type];
  const data = ev.data ?? {};
  if (!name) return;
  const wanted = (collection: CollectionName, key: string) => !only || only(collection, key);

  for (const att of data.attachments ?? []) {
    const row = att as unknown as AnyRow;
    if (wanted("attachments", keyOf("attachments", row))) d.put("attachments", row);
  }

  if (data.row) {
    const row = data.row;
    // A task opened earlier keeps nothing stale: the event row is complete.
    if (wanted(name, keyOf(name, row))) d.put(name, row);
    return;
  }

  const id = name === "watchers" ? `${String(data.user_id ?? ev.audience_id)}:${ev.entity_id}` : ev.entity_id;
  if (data.gone === true) {
    if (wanted(name, id)) d.drop(name, id);
    return;
  }
  if (data.changes) {
    const fields: AnyRow = {};
    for (const [field, change] of Object.entries(data.changes)) fields[field] = change.to;
    if (name === "tasks") fields.updated_at = ev.at;
    // The server stamps the row with the event's position; keep the copy's stamp in step,
    // so an older copy of the row arriving later is recognised as older.
    if (TRACKED.has(name)) fields.updated_seq = ev.seq;
    for (const target of data.ids ?? [id]) {
      if (wanted(name, target)) d.patch(name, target, fields);
    }
  }
}

/** The rows an event names: the keys it would write in its own collection. */
export function targetsOf(ev: FeedEvent): { collection: CollectionName; keys: string[]; gone: boolean } | null {
  const name = COLLECTION_OF[ev.entity_type];
  if (!name) return null;
  const data = ev.data ?? {};
  if (data.row) return { collection: name, keys: [keyOf(name, data.row)], gone: false };
  const id = name === "watchers" ? `${String(data.user_id ?? ev.audience_id)}:${ev.entity_id}` : ev.entity_id;
  return { collection: name, keys: data.ids ?? [id], gone: data.gone === true };
}
