// What the docs part keeps beside the workspace copy (lib/store.ts). Pages
// themselves live there, in `docs`; here are the things only an opened page
// brings: a database's properties and views, what links to a page, and who
// else is in it. Properties and views follow the live feed like any row.

import { create } from "zustand";
import { api, ws } from "@/lib/api";
import { type Dict, getState, mergeRows, onEvents, removeRow, useStore } from "@/lib/store";
import type { FeedEvent } from "@/lib/types";
import type { DBProperty, DBView, DocRef, DocSource, PageData, PresenceEntry } from "@/docs/types";

export interface PageMeta {
  mentioned_in: DocRef[];
  mentions: DocRef[];
  source?: DocSource;
}

interface DocsState {
  props: Dict<DBProperty>;
  views: Dict<DBView>;
  meta: Dict<PageMeta>;
  /** Who else has each page open, by page id. */
  presence: Dict<PresenceEntry[]>;
}

const empty = (): DocsState => ({ props: {}, views: {}, meta: {}, presence: {} });

export const useDocsStore = create<DocsState>(empty);

type Table = "props" | "views";

/** Adds or replaces a property or view. */
export function putRow<K extends Table>(table: K, row: DocsState[K][string]) {
  useDocsStore.setState((s) => ({ [table]: { ...s[table], [row.id]: row } }));
}

/** Sets fields on a property or view; returns the row as it was, to put back if the server refuses. */
export function patchRow<K extends Table>(table: K, id: string, fields: Partial<DocsState[K][string]>) {
  const before = useDocsStore.getState()[table][id];
  if (before) putRow(table, { ...before, ...fields } as DocsState[K][string]);
  return before;
}

export function dropRow(table: Table, id: string) {
  useDocsStore.setState((s) => {
    const next = { ...s[table] };
    delete next[id];
    return { [table]: next };
  });
}

export function setPresence(docId: string, others: PresenceEntry[]) {
  useDocsStore.setState((s) => ({ presence: { ...s.presence, [docId]: others } }));
}

const TABLE_OF: Record<string, Table> = { property: "props", dbview: "views" };

function applyDocEvents(events: FeedEvent[]) {
  for (const ev of events) {
    const table = TABLE_OF[ev.entity_type];
    if (!table) continue;
    const data = ev.data ?? {};
    if (data.row) {
      putRow(table, data.row as unknown as DBProperty & DBView);
    } else if (data.changes) {
      const fields: Record<string, unknown> = {};
      for (const [field, change] of Object.entries(data.changes)) fields[field] = change.to ?? undefined;
      patchRow(table, ev.entity_id, fields);
    }
  }
}

onEvents(applyDocEvents);

// Another workspace: nothing kept here belongs to it.
let lastSlug = getState().slug;
useStore.subscribe((s) => {
  if (s.slug === lastSlug) return;
  lastSlug = s.slug;
  useDocsStore.setState(empty());
});

/**
 * Fetches one page with everything around it and files it: the page, its
 * sub-pages, rows and comments into the workspace copy, the rest here. The
 * blocks are returned to the caller; only an open editor holds them.
 */
export async function loadPage(id: string, signal?: AbortSignal): Promise<PageData> {
  const slug = getState().slug;
  const data = await api.get<PageData>(ws(slug, `/docs/${id}`), signal);
  mergeRows("docs", [data.doc, ...(data.children ?? []), ...(data.rows ?? [])] as never[]);
  mergeRows("comments", (data.comments ?? []) as never[]);
  useDocsStore.setState((s) => {
    const props = { ...s.props };
    const views = { ...s.views };
    for (const p of data.properties ?? []) props[p.id] = p;
    for (const v of data.views ?? []) views[v.id] = v;
    return {
      props,
      views,
      meta: {
        ...s.meta,
        [id]: { mentioned_in: data.mentioned_in ?? [], mentions: data.mentions ?? [], source: data.source },
      },
    };
  });
  return data;
}

/**
 * Someone else's private page that the server no longer lets this person
 * open was shared with them and is not any more. The feed does not tell the
 * one who lost it, so the refusal does: take the page out of the copy.
 */
export function forgetIfUnshared(id: string) {
  const { c, me } = getState();
  const owner = (c.docs[id] as { owner_id?: string } | undefined)?.owner_id;
  if (owner && owner !== me?.user_id) removeRow("docs", id);
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
