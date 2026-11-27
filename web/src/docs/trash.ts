// The trash for pages. The server lists the deleted pages this person may
// see; they are put into the workspace copy (marked deleted, so nothing
// else shows them), and from then on the live feed keeps them current: a
// page deleted or restored anywhere shows up or drops out here.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, workspacePath } from "@/data/api";
import { queryClient } from "@/data/query";
import { getRowEvenIfGone, useLookupEvenIfGone, useMe, useSlug, useTrashed as useTrashedRows } from "@/data/selectors";
import { getState, mergeRows } from "@/data/store";
import { canSeePage } from "@/data/access";
import { docsKeys } from "@/docs/store";
import type { Doc } from "@/types/docs";

export interface Trashed {
  id: string;
  title: string;
  icon?: string;
  kind: string;
  project_id?: string;
  deleted_at: number;
}

/** Fetches the deleted pages into the workspace copy. A page the copy already has is left alone: the feed is newer. */
async function fetchTrash(slug: string, signal: AbortSignal): Promise<true> {
  const { docs } = await api.get<{ docs: Doc[] }>(workspacePath(slug, "/docs?trash=1"), signal);
  if (getState().slug === slug) mergeRows("docs", docs.filter((d) => !getRowEvenIfGone("docs", d.id)) as never[]);
  return true;
}

/** Asks the server for the trash again (the trash is opened), sharing a fetch already on its way. */
export const loadTrash = () =>
  queryClient.refetchQueries({ queryKey: docsKeys.trash(getState().slug) }, { cancelRefetch: false });

/** Deleted pages, newest first; with a project, those tied to it. Only the top of what went together: the pages under it come back with it. */
export function useTrashed(projectId?: string): Trashed[] {
  const trashed = useTrashedRows("docs");
  // To tell the top of what went together: a parent trashed in the same go.
  const docs = useLookupEvenIfGone("docs");
  const me = useMe();
  const slug = useSlug();
  // Asked again when the stream comes back: a copy fetched afresh after a long gap starts without the trash.
  // A failure leaves the trash showing what the feed reported during this visit.
  useQuery({ queryKey: docsKeys.trash(slug), queryFn: ({ signal }) => fetchTrash(slug, signal) });
  return useMemo(() => {
    const out: Trashed[] = [];
    for (const doc of trashed) {
      if (!doc.deleted_at || doc.kind === "row" || !canSeePage(doc, me.user_id)) continue;
      if (projectId && doc.project_id !== projectId) continue;
      const parent = doc.parent_id ? docs[doc.parent_id] : undefined;
      if (parent?.deleted_at === doc.deleted_at) continue;
      out.push({
        id: doc.id,
        title: doc.title,
        icon: doc.icon,
        kind: doc.kind,
        project_id: doc.project_id,
        deleted_at: doc.deleted_at,
      });
    }
    return out;
  }, [trashed, docs, me.user_id, projectId]);
}
