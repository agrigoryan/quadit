// Reading pages from the workspace copy: the tree, its sections, the path
// to a page, a database's rows, properties and views.

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useCollection, useMe } from "@/lib/selectors";
import { type Dict, getState, useStore } from "@/lib/store";
import { useDocsStore } from "@/docs/store";
import type { DBProperty, DBView, Doc, DocComment } from "@/docs/types";

export const byRank = (a: { rank: string; id: string }, b: { rank: string; id: string }) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1;

export const docTitle = (doc: Pick<Doc, "title"> | undefined) => doc?.title?.trim() || t("docs.untitled");

export function useDocs(): Dict<Doc> {
  return useCollection("docs") as unknown as Dict<Doc>;
}

export function useDoc(id: string | undefined): Doc | undefined {
  return useStore((s) => (id ? (s.c.docs[id] as unknown as Doc | undefined) : undefined));
}

export const getDoc = (id: string) => getState().c.docs[id] as unknown as Doc | undefined;
export const getDocs = () => getState().c.docs as unknown as Dict<Doc>;

/** Whether this person may see a page: a private one shows to its owner and those it is shared with. */
export const canSee = (doc: Doc, userId: string) => !doc.owner_id || doc.owner_id === userId || !!doc.shared_with?.includes(userId);

export type Section = "team" | "private" | "memory" | "generated";

export function sectionOf(doc: Doc): Section {
  if (doc.memory_of) return "memory";
  if (doc.generated) return "generated";
  if (doc.owner_id) return "private";
  return "team";
}

export interface DocTree {
  /** Pages of a section with no parent in the same section, in order. */
  roots: Record<Section, Doc[]>;
  /** Sub-pages by parent id, in order. Rows of a database are not pages of the tree. */
  children: Dict<Doc[]>;
}

/** The page tree as the person may see it, without the trash, the archive and database rows. */
export function buildTree(docs: Dict<Doc>, userId: string): DocTree {
  const roots: DocTree["roots"] = { team: [], private: [], memory: [], generated: [] };
  const children: Dict<Doc[]> = {};
  const shown = (d: Doc | undefined): d is Doc => !!d && !d.deleted_at && !d.archived_at && d.kind !== "row" && canSee(d, userId);
  for (const doc of Object.values(docs)) {
    if (!shown(doc)) continue;
    const parent = doc.parent_id ? docs[doc.parent_id] : undefined;
    if (shown(parent) && sectionOf(parent) === sectionOf(doc)) (children[parent.id] ??= []).push(doc);
    else roots[sectionOf(doc)].push(doc);
  }
  for (const list of Object.values(roots)) list.sort(byRank);
  for (const list of Object.values(children)) list.sort(byRank);
  return { roots, children };
}

export function useDocTree(): DocTree {
  const docs = useDocs();
  const me = useMe();
  return useMemo(() => buildTree(docs, me.user_id), [docs, me.user_id]);
}

/** The pages above a page, outermost first. */
export function pathTo(docs: Dict<Doc>, id: string): Doc[] {
  const out: Doc[] = [];
  let cur = docs[id]?.parent_id;
  for (let depth = 0; cur && depth < 60; depth++) {
    const doc = docs[cur];
    if (!doc) break;
    out.unshift(doc);
    cur = doc.parent_id;
  }
  return out;
}

/** True when `id` is `ancestor` or somewhere under it. */
export function isWithin(docs: Dict<Doc>, id: string, ancestor: string): boolean {
  for (let cur: string | undefined = id, depth = 0; cur && depth < 60; depth++) {
    if (cur === ancestor) return true;
    cur = docs[cur]?.parent_id;
  }
  return false;
}

/** A database's rows, in manual order. */
export function useRows(databaseId: string | undefined): Doc[] {
  const docs = useDocs();
  return useMemo(
    () =>
      databaseId
        ? Object.values(docs)
            .filter((d) => d.parent_id === databaseId && d.kind === "row" && !d.deleted_at)
            .sort(byRank)
        : [],
    [docs, databaseId],
  );
}

export function useProperties(databaseId: string | undefined): DBProperty[] {
  const props = useDocsStore((s) => s.props);
  return useMemo(
    () =>
      databaseId
        ? Object.values(props)
            .filter((p) => p.database_id === databaseId && !p.deleted_at)
            .sort(byRank)
        : [],
    [props, databaseId],
  );
}

export function useViews(databaseId: string | undefined): DBView[] {
  const views = useDocsStore((s) => s.views);
  return useMemo(
    () =>
      databaseId
        ? Object.values(views)
            .filter((v) => v.database_id === databaseId && !v.deleted_at)
            .sort(byRank)
        : [],
    [views, databaseId],
  );
}

/** The comments of a page and its blocks, oldest first. */
export function useDocComments(docId: string): DocComment[] {
  const comments = useCollection("comments") as unknown as Dict<DocComment>;
  return useMemo(
    () =>
      Object.values(comments)
        .filter((c) => c.doc_id === docId && !c.deleted_at)
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)),
    [comments, docId],
  );
}

/** Pages a person may link to or move under: everything visible that is not a row. */
export function useLinkablePages(): Doc[] {
  const docs = useDocs();
  const me = useMe();
  return useMemo(
    () =>
      Object.values(docs)
        .filter((d) => !d.deleted_at && !d.archived_at && d.kind !== "row" && canSee(d, me.user_id))
        .sort((a, b) => docTitle(a).localeCompare(docTitle(b))),
    [docs, me.user_id],
  );
}
