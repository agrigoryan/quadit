// The trash for pages. The server lists the deleted pages this person may
// see; they are put into the workspace copy (marked deleted, so nothing
// else shows them), and from then on the live feed keeps them current: a
// page deleted or restored anywhere shows up or drops out here.

import { useEffect, useMemo } from "react";
import { api, workspacePath } from "@/lib/api";
import { useMe } from "@/lib/selectors";
import { getState, mergeRows, useStore } from "@/lib/store";
import { canSee, useDocs } from "@/docs/data";
import type { Doc } from "@/docs/types";

export interface Trashed {
  id: string;
  title: string;
  icon?: string;
  kind: string;
  deleted_at: number;
}

let loading: Promise<void> | null = null;

/** Fetches the deleted pages into the workspace copy. A page the copy already has is left alone: the feed is newer. */
export function loadTrash(): Promise<void> {
  const slug = getState().slug;
  if (!slug) return Promise.resolve();
  loading ??= api
    .get<{ docs: Doc[] }>(workspacePath(slug, "/docs?trash=1"))
    .then(({ docs }) => {
      if (getState().slug !== slug) return;
      const have = getState().collections.docs;
      mergeRows("docs", docs.filter((d) => !have[d.id]) as never[]);
    })
    .catch(() => {
      // The trash then shows what the feed reported during this visit.
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Deleted pages, newest first; with a project, those tied to it. Only the top of what went together: the pages under it come back with it. */
export function useTrashed(projectId?: string): Trashed[] {
  const docs = useDocs();
  const me = useMe();
  const slug = useStore((s) => s.slug);
  // Asked again when the stream comes back: a copy fetched afresh after a long gap starts without the trash.
  const live = useStore((s) => s.stream === "live");
  useEffect(() => {
    void loadTrash();
  }, [slug, live]);
  return useMemo(() => {
    const out: Trashed[] = [];
    for (const doc of Object.values(docs)) {
      if (!doc.deleted_at || doc.kind === "row" || !canSee(doc, me.user_id)) continue;
      if (projectId && doc.project_id !== projectId) continue;
      const parent = doc.parent_id ? docs[doc.parent_id] : undefined;
      if (parent?.deleted_at === doc.deleted_at) continue;
      out.push({ id: doc.id, title: doc.title, icon: doc.icon, kind: doc.kind, deleted_at: doc.deleted_at });
    }
    return out.sort((a, b) => b.deleted_at - a.deleted_at);
  }, [docs, me.user_id, projectId]);
}
