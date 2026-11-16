// What the docs part keeps beside the workspace copy (data/store.ts). Pages
// themselves live there, in `docs`, and so do a database's properties and
// views (`properties`, `dbviews`), which follow the feed like any row; here
// are the things only an opened page brings that are no rows: what links to
// a page, and who else is in it. Also the keys the docs part's reads are
// cached under, and the read of one page, which files what it brings in
// both stores.

import { queryOptions } from "@tanstack/react-query";
import { create } from "zustand";
import { api, workspacePath } from "@/data/api";
import { inWorkspace, isNotFound, queryClient } from "@/data/query";
import { getRowEvenIfGone } from "@/data/selectors";
import { type Dict, getState, mergeRows, onEvents, removeRow, useStore } from "@/data/store";
import type { BlockRow, DocRef, DocSource, PageData, PresenceEntry } from "@/types/docs";

interface PageMeta {
  mentioned_in: DocRef[];
  mentions: DocRef[];
  source?: DocSource;
}

interface DocsState {
  meta: Dict<PageMeta>;
  /** Who else has each page open, by page id. */
  presence: Dict<PresenceEntry[]>;
}

const empty = (): DocsState => ({ meta: {}, presence: {} });

export const useDocsStore = create<DocsState>(empty);

export function setPresence(docId: string, others: PresenceEntry[]) {
  useDocsStore.setState((s) => ({ presence: { ...s.presence, [docId]: others } }));
}

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
  mergeRows("properties", data.properties ?? []);
  mergeRows("dbviews", data.views ?? []);
  useDocsStore.setState((s) => ({
    meta: {
      ...s.meta,
      [id]: { mentioned_in: data.mentioned_in ?? [], mentions: data.mentions ?? [], source: data.source },
    },
  }));
  return { blocks: data.blocks ?? [], seq: data.doc.content_seq ?? 0 };
}

/** A task's link to a page is gone: no page lists the reference the link made any more. */
export function forgetLink(linkId: string) {
  useDocsStore.setState((s) => {
    const meta: Dict<PageMeta> = {};
    let changed = false;
    for (const [docId, page] of Object.entries(s.meta)) {
      const mentioned_in = page.mentioned_in.filter((ref) => ref.from_id !== linkId);
      changed ||= mentioned_in.length !== page.mentioned_in.length;
      meta[docId] = mentioned_in.length === page.mentioned_in.length ? page : { ...page, mentioned_in };
    }
    return changed ? { meta } : s;
  });
}

// A link taken off a task, by anyone: the feed says so even when the link's
// row is not in the copy (its task was never opened here), and a page read
// earlier still holds the reference it made. A link made comes with its row,
// which the copy keeps (docs/page/tasks-panel.tsx reads both).
onEvents((events) => {
  for (const ev of events) {
    if (ev.entity_type === "link" && ev.data?.changes?.deleted_at?.to) forgetLink(ev.entity_id);
  }
});

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
