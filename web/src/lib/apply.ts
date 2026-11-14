// How rows get into the collections: which collection a kind of row lives
// in, what its key is, and how one feed event changes the copy.

import type { CollectionName, Collections, Dict } from "@/lib/store";
import type { FeedEvent } from "@/lib/types";
import { localPath } from "@/lib/url";

export type AnyRow = Record<string, unknown>;

/** Which collection an event's entity_type lives in. */
export const COLLECTION_OF: Record<string, CollectionName> = {
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
};

export const emptyCollections = (): Collections => {
  const c = {} as Record<CollectionName, Dict<never>>;
  for (const name of new Set(Object.values(COLLECTION_OF))) c[name] = {};
  return c as Collections;
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
export class Draft {
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

/** Applies one feed event to the draft. Applying an event twice is harmless. */
export function applyEvent(d: Draft, ev: FeedEvent) {
  const name = COLLECTION_OF[ev.entity_type];
  const data = ev.data ?? {};
  if (!name) return;

  for (const att of data.attachments ?? []) d.put("attachments", att as unknown as AnyRow);

  if (data.row) {
    const row = data.row;
    // A task opened earlier keeps nothing stale: the event row is complete.
    d.put(name, row);
    return;
  }

  const id = name === "watchers" ? `${String(data.user_id ?? ev.audience_id)}:${ev.entity_id}` : ev.entity_id;
  if (data.gone === true) {
    d.drop(name, id);
    return;
  }
  if (data.changes) {
    const fields: AnyRow = {};
    for (const [field, change] of Object.entries(data.changes)) fields[field] = change.to;
    if (name === "tasks") fields.updated_at = ev.at;
    for (const target of data.ids ?? [id]) d.patch(name, target, fields);
  }
}

