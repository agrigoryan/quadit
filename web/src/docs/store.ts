// What the docs part keeps beside the workspace copy (lib/store.ts). Pages
// themselves live there, in `docs`; here are the things only an opened page
// brings: a database's properties and views, what links to a page, and who
// else is in it. Properties and views follow the live feed like any row.
// Also the keys the docs part's reads are cached under, and the read of one
// page, which files what it brings in both stores.

import { queryOptions } from "@tanstack/react-query";
import { create } from "zustand";
import { api, workspacePath } from "@/lib/api";
import { inWorkspace, isNotFound, queryClient } from "@/lib/query";
import { getRowEvenIfGone } from "@/lib/selectors";
import { type Dict, getState, mergeRows, onEvents, removeRow, useStore } from "@/lib/store";
import type { FeedEvent } from "@/types/core";
import type { BlockRow, DBProperty, DBView, DocRef, DocSource, PageData, PresenceEntry } from "@/types/docs";

interface PageMeta {
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
      putRow(table, data.row as DBProperty & DBView); // a feed row is JSON, unchecked
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

export const docsKeys = {
  page: (slug: string, id: string) => [...inWorkspace(slug), "page", id] as const,
  trash: (slug: string) => [...inWorkspace(slug), "docs-trash"] as const,
  /** A page's kept versions. */
  versions: (slug: string, id: string) => [...inWorkspace(slug), "versions", id] as const,
  /** One kept version's blocks, which never change. */
  version: (slug: string, id: string, versionId: string) => [...inWorkspace(slug), "versions", id, versionId] as const,
  /** A gallery card's picture, as of one version of the row's content. */
  cover: (slug: string, rowId: string, contentSeq: number) =>
    [...inWorkspace(slug), "cover", rowId, contentSeq] as const,
};

/** What only an open editor holds of a page: its blocks, and its content position when they were read. */
export interface PageContent {
  blocks: BlockRow[];
  seq: number;
}

/**
 * Fetches one page with everything around it and files it: the page, its
 * sub-pages, rows and comments into the workspace copy, the rest here. The
 * blocks are the answer; only an open editor holds them. A page refused as
 * not there that was shared with this person is taken out of the copy.
 */
async function fetchPage(slug: string, id: string, signal: AbortSignal): Promise<PageContent> {
  let data: PageData;
  try {
    data = await api.get<PageData>(workspacePath(slug, `/docs/${id}`), signal);
  } catch (err) {
    if (isNotFound(err)) forgetIfUnshared(id);
    throw err;
  }
  // The copy was replaced while this was on its way: nothing of it belongs to the one there now.
  if (getState().slug !== slug) return { blocks: data.blocks ?? [], seq: data.doc.content_seq ?? 0 };
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
  return { blocks: data.blocks ?? [], seq: data.doc.content_seq ?? 0 };
}

/** One page, read through the query cache (see fetchPage). */
export const pageQuery = (slug: string, id: string) =>
  queryOptions({ queryKey: docsKeys.page(slug, id), queryFn: ({ signal }) => fetchPage(slug, id, signal) });

/** Fetches a page now, sharing a fetch of it already on its way (the editor's resync, a restored page). */
export const loadPage = (id: string) => queryClient.fetchQuery(pageQuery(getState().slug, id));

/**
 * Someone else's private page that the server no longer lets this person
 * open was shared with them and is not any more. The feed does not tell the
 * one who lost it, so the refusal does: take the page out of the copy.
 */
function forgetIfUnshared(id: string) {
  // In the trash or not: the person may no longer see it either way.
  const owner = getRowEvenIfGone("docs", id)?.owner_id;
  if (owner && owner !== getState().me?.user_id) removeRow("docs", id);
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
