// How rows get into the collections: how a row is filed and how one feed
// event changes the copy (data/collections.ts says where each kind lives).

import {
  type AnyRow,
  COLLECTION_OF,
  type CollectionName,
  type Collections,
  type Dict,
  keyOf,
} from "@/data/collections";
import type { FeedEvent } from "@/types/core";
import { localPath } from "@/lib/url";

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
    return this.next[name] ?? this.base[name];
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

  if (ev.type === "task.related") {
    applyRelated(d, ev, wanted);
    return;
  }

  for (const att of data.attachments ?? []) {
    const row: AnyRow = att;
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
  if (data.appended) {
    for (const target of data.ids ?? [id]) {
      if (wanted(name, target)) appendTo(d, name, target, ev);
    }
  }
  if (data.changes) {
    const fields: AnyRow = {};
    for (const [field, change] of Object.entries(data.changes)) fields[field] = change.to;
    if (name === "tasks") fields.updated_at = ev.at;
    // The server stamps every row it changes with the event's position; keep the copy's stamp
    // in step, so an older copy of the row arriving later (a fetch answered after the change)
    // is recognised as older, whatever kind of row it is.
    fields.updated_seq = ev.seq;
    for (const target of data.ids ?? [id]) {
      if (wanted(name, target)) d.patch(name, target, fields);
    }
  }
}

/**
 * Adds an event's appended items to the end of the row's lists (a run's
 * steps and links). The event carries only what is new, so it is applied
 * only to a row older than it: applied twice, or over a copy of the row
 * fetched after it, it changes nothing. When the server's cap dropped
 * steps from the front (the event's `steps_dropped` change), the copy drops
 * as many. The row is stamped with the event's seq here, before the
 * event's changes are patched in, for an event that carries none.
 */
function appendTo(d: CopyOnWrite, name: CollectionName, id: string, ev: FeedEvent) {
  const row = d.peek(name)[id];
  const appended = ev.data.appended ?? {};
  if (!row || ev.seq <= Number(row.updated_seq ?? 0)) return;
  const fields: AnyRow = { updated_seq: ev.seq };
  for (const [field, items] of Object.entries(appended)) {
    const held = Array.isArray(row[field]) ? (row[field] as unknown[]) : [];
    fields[field] = [...held, ...items];
  }
  const before = Number(row.steps_dropped ?? 0);
  const after = Number(ev.data.changes?.steps_dropped?.to ?? before);
  if (after > before && Array.isArray(fields.steps)) fields.steps = fields.steps.slice(after - before);
  d.patch(name, id, fields);
}

/**
 * `task.related` is a relation as told to the task at its `related_task_id` end. It reaches a
 * reader of that task who may not read the relation's own event (its `task_id` end is in a
 * project they cannot read), so it adds the row, or drops it when `removed`, as /list/relations
 * gives it to that reader: the far end (`other_id`) blank when the event leaves it out. A reader
 * of both ends got the whole row from the relation's own event just before, and it is kept.
 */
function applyRelated(d: CopyOnWrite, ev: FeedEvent, wanted: (collection: CollectionName, key: string) => boolean) {
  const data = ev.data;
  const id = typeof data.relation === "string" ? data.relation : "";
  if (!id || !wanted("relations", id)) return;
  if (data.removed === true) {
    d.drop("relations", id);
    return;
  }
  if (id in d.peek("relations")) return;
  d.put("relations", {
    id,
    task_id: typeof data.other_id === "string" ? data.other_id : "",
    related_task_id: ev.entity_id,
    type: data.type,
    created_by: ev.actor_id,
    created_at: ev.at,
  });
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
