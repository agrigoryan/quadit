// Reading pages from the workspace copy: the tree, its sections, the path
// to a page, a database's rows, properties and views.

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useCollection, useMe } from "@/lib/selectors";
import { type Dict, getState, useStore } from "@/lib/store";
import { useDocsStore } from "@/docs/store";
import type { DBProperty, DBView, Doc, DocComment } from "@/lib/types-docs";

export const byRank = (a: { rank: string; id: string }, b: { rank: string; id: string }) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1;

export const docTitle = (doc: Pick<Doc, "title"> | undefined) => doc?.title?.trim() || t("docs.untitled");

export function useDocs(): Dict<Doc> {
  return useCollection("docs");
}

export function useDoc(id: string | undefined): Doc | undefined {
  return useStore((s) => (id ? s.collections.docs[id] : undefined));
}

export const getDoc = (id: string): Doc | undefined => getState().collections.docs[id];
export const getDocs = (): Dict<Doc> => getState().collections.docs;

/**
 * True unless the person is limited to some projects and the page is tied
 * to another. The server sends such a person no page of another project; one
 * that is moved out of theirs while they look is still in the copy.
 */
function withinMyProjects(doc: Doc): boolean {
  const mine = getState().me?.scope?.projects;
  return !doc.project_id || !mine?.length || mine.includes(doc.project_id);
}

/** Whether this person may see a page: a private one shows to its owner and those it is shared with, a project's to those who see the project. */
export const canSee = (doc: Doc, userId: string) =>
  (!doc.owner_id || doc.owner_id === userId || !!doc.shared_with?.includes(userId)) && withinMyProjects(doc);

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
function buildTree(docs: Dict<Doc>, userId: string): DocTree {
  const roots: DocTree["roots"] = { team: [], private: [], memory: [], generated: [] };
  const children: Dict<Doc[]> = {};
  const shown = (d: Doc | undefined): d is Doc =>
    !!d && !d.deleted_at && !d.archived_at && d.kind !== "row" && canSee(d, userId);
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

/**
 * The part of the tree that is one project's: the pages tied to it, each
 * with everything under it. A page under one of them that is tied elsewhere
 * stays in its place there, and says so (docs/project-mark.tsx).
 */
function projectTree(tree: DocTree, projectId: string): DocTree {
  const roots: DocTree["roots"] = { team: [], private: [], memory: [], generated: [] };
  const collect = (list: Doc[], into: Doc[]) => {
    for (const doc of list) {
      if (doc.project_id === projectId) into.push(doc);
      else collect(tree.children[doc.id] ?? [], into);
    }
  };
  for (const section of Object.keys(roots) as Section[]) collect(tree.roots[section], roots[section]);
  return { roots, children: tree.children };
}

/** The page tree: the whole workspace's, or one project's. */
export function useDocTree(projectId?: string): DocTree {
  const docs = useDocs();
  const me = useMe();
  return useMemo(() => {
    const tree = buildTree(docs, me.user_id);
    return projectId ? projectTree(tree, projectId) : tree;
  }, [docs, me.user_id, projectId]);
}

export const treeIsEmpty = (tree: DocTree) => Object.values(tree.roots).every((list) => list.length === 0);

/** True when a page is one of a project's pages: tied to it, or under a page that is. */
export function inProject(docs: Dict<Doc>, id: string, projectId: string): boolean {
  for (let cur = docs[id], depth = 0; cur && depth < 60; depth++) {
    if (cur.project_id === projectId) return true;
    cur = cur.parent_id ? docs[cur.parent_id] : undefined;
  }
  return false;
}

/**
 * The pages under a page that are in its project, down to the first that
 * is not: they are in the project because the page is, and go with it when
 * its project changes. The server's rule (internal/engine/ch_doc_project.go).
 */
export function sameProjectBelow(docs: Dict<Doc>, root: Doc): Doc[] {
  const byParent: Dict<Doc[]> = {};
  for (const doc of Object.values(docs)) if (doc.parent_id) (byParent[doc.parent_id] ??= []).push(doc);
  const out: Doc[] = [];
  for (let at = [root]; at.length > 0; at = at.slice(1)) {
    for (const kid of byParent[(at[0] as Doc).id] ?? []) {
      if ((kid.project_id ?? "") !== (root.project_id ?? "")) continue;
      out.push(kid);
      at.push(kid);
    }
  }
  return out;
}

/** How many pages are under a page, not counting a database's rows or the trash. */
export function countBelow(docs: Dict<Doc>, id: string): number {
  let n = 0;
  for (const doc of Object.values(docs)) {
    if (doc.id !== id && doc.kind !== "row" && !doc.deleted_at && isWithin(docs, doc.id, id)) n++;
  }
  return n;
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
  const comments = useCollection("comments");
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
