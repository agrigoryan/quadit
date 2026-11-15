// Every way the app changes a page, in one place. Each function shows the
// change at once and sends it as a named change (see lib/mutate.ts).

import type { Changes } from "@/lib/changes.gen";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate, send } from "@/lib/mutate";
import { rankBetween } from "@/lib/rank";
import { getLookupEvenIfGone, getRow, getRowEvenIfGone, getRows } from "@/lib/selectors";
import { isNotFound, readError } from "@/lib/query";
import { getState } from "@/lib/store";
import { toast } from "@/lib/toast";
import { sameProjectBelow } from "@/docs/data";
import { loadPage } from "@/docs/store";
import type { Doc, DocComment, DocKind } from "@/lib/types-docs";

type Fields = Record<string, unknown>;

export interface NewDoc {
  parentId?: string;
  title?: string;
  kind?: "page" | "database";
  icon?: string;
  /** The project it is tied to. Left out, a page under another is in its parent's project, and one at the top in none. */
  projectId?: string;
  /** Only the person making it sees it. */
  private?: boolean;
  /** decision_log, changelog or open_questions: a page built from data. */
  generated?: string;
  /** The page's first content. */
  markdown?: string;
  /** A row's values, by property id. */
  props?: Fields;
  rank?: string;
}

/** The rank that puts a new page last among the pages under a parent. */
export function lastRank(parentId: string | undefined): string {
  let last = "";
  for (const d of getRows("docs")) {
    if ((d.parent_id ?? "") === (parentId ?? "") && d.rank > last) last = d.rank;
  }
  return rankBetween(last || undefined, undefined);
}

/** Creates a page (or a database, or a row under a database). It shows at once; resolves with its id. */
export function createDoc(input: NewDoc = {}): string {
  const { me } = getState();
  const id = newId();
  const parent = getRow("docs", input.parentId);
  const rank = input.rank ?? lastRank(input.parentId);
  const kind: DocKind = parent?.kind === "database" && input.kind !== "database" ? "row" : (input.kind ?? "page");
  const args: Changes["doc.create"] = { id, title: input.title ?? "", rank };
  if (input.parentId) args.parent = input.parentId;
  if (input.kind === "database") args.kind = "database";
  if (input.icon) args.icon = input.icon;
  if (input.projectId) args.project = input.projectId;
  if (input.private) args.private = true;
  if (input.generated) args.generated = input.generated;
  if (input.markdown) args.markdown = input.markdown;
  if (input.props && Object.keys(input.props).length) args.props = input.props;
  const now = Date.now();
  send({ type: "doc.create", args }, (tx) =>
    tx.insert("docs", {
      id,
      parent_id: input.parentId,
      kind,
      title: input.title ?? "",
      icon: input.icon,
      generated: input.generated,
      // A page under a private page is private the same way.
      owner_id: input.private ? me?.user_id : parent?.owner_id,
      shared_with: parent?.shared_with,
      memory_of: parent?.memory_of,
      project_id: input.projectId ?? parent?.project_id,
      props: input.props,
      rank,
      created_by: me?.user_id,
      created_at: now,
      updated_at: now,
    }),
  );
  return id;
}

/** Sets simple fields of a page: title, icon, cover. */
export function updateDoc(id: string, fields: Partial<Pick<Doc, "title" | "icon" | "cover">>) {
  const doc = getRow("docs", id);
  if (!doc) return;
  const changed: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if ((doc as Fields)[key] !== value && !(value === "" && (doc as Fields)[key] === undefined)) changed[key] = value;
  }
  if (Object.keys(changed).length === 0) return;
  const local: Fields = {};
  for (const [key, value] of Object.entries(changed)) local[key] = value === "" && key !== "title" ? null : value;
  send({ type: "doc.update", args: { id, ...changed } }, (tx) =>
    tx.patch("docs", id, { ...local, updated_at: Date.now() }),
  );
}

/** Moves a page in the tree: under another page (or to the top), at a place among its new siblings. */
export function moveDoc(id: string, parentId: string | null, rank: string) {
  const doc = getRow("docs", id);
  if (!doc) return;
  const args: Changes["doc.update"] = { id, rank };
  if ((doc.parent_id ?? null) !== parentId) args.parent = parentId;
  send({ type: "doc.update", args }, (tx) => tx.patch("docs", id, { parent_id: parentId, rank }));
}

/** Makes a page private to its owner (and those it is shared with) or visible to the team. */
export function setSharing(id: string, sharing: { private?: boolean; sharedWith?: string[] }) {
  const { me } = getState();
  const args: Changes["doc.update"] = { id };
  const local: Fields = {};
  if (sharing.private !== undefined) {
    args.private = sharing.private;
    local.owner_id = sharing.private ? me?.user_id : null;
    if (!sharing.private) {
      args.shared_with = [];
      local.shared_with = null;
    }
  }
  if (sharing.sharedWith) {
    args.shared_with = sharing.sharedWith;
    local.shared_with = sharing.sharedWith.length ? sharing.sharedWith : null;
  }
  send({ type: "doc.update", args }, (tx) => tx.patch("docs", id, local));
}

/**
 * Ties a page to a project, or to none. The pages under it that are in its
 * project go with it. Returns the pages that went along, the page itself
 * not among them.
 */
export function setProject(id: string, projectId: string | null): Doc[] {
  const doc = getRow("docs", id);
  if (!doc || (doc.project_id ?? null) === projectId) return [];
  // The server takes the trashed pages under it along too, so one restored later comes back where its parent is.
  const along = sameProjectBelow(getLookupEvenIfGone("docs"), doc);
  send({ type: "doc.update", args: { id, project: projectId } }, (tx) => {
    for (const each of [doc, ...along]) tx.patch("docs", each.id, { project_id: projectId });
  });
  return along;
}

/** A page and every page under it. */
function subtree(id: string): Doc[] {
  const all = getRows("docs");
  const out: Doc[] = [];
  const walk = (parent: string) => {
    for (const d of all) {
      if (d.parent_id === parent) {
        out.push(d);
        walk(d.id);
      }
    }
  };
  const root = getRow("docs", id);
  if (root) out.push(root);
  walk(id);
  return out;
}

/** Brings a page back from the trash, with the pages that went with it. */
export function restoreDoc(id: string) {
  const known = getRowEvenIfGone("docs", id);
  const at = known?.deleted_at;
  const ids = Object.values(getLookupEvenIfGone("docs"))
    .filter((d) => d.id === id || (at && d.deleted_at === at))
    .map((d) => d.id);
  mutate({ type: "doc.restore", args: { id } }, (tx) => {
    for (const each of ids) tx.patch("docs", each, { deleted_at: null });
  })
    .then(() => {
      // A page the workspace copy never had (deleted before this visit) is fetched whole.
      if (known) return;
      loadPage(id).catch((err: unknown) => {
        // Not there for this person after all: there is nothing to show. Anything else, say.
        const why = readError(err);
        if (why && !isNotFound(err)) toast.error(t("docs.trash.restoredNotLoaded", { why }));
      });
    })
    // Refused: mutate has said why and put the page back in the trash.
    .catch(() => {});
}

/** Moves a page and the pages under it to the trash, with a way back. */
export function trashDoc(id: string) {
  const doc = getRow("docs", id);
  if (!doc) return;
  const all = subtree(id);
  const at = Date.now();
  send({ type: "doc.delete", args: { id } }, (tx) => {
    for (const d of all) tx.patch("docs", d.id, { deleted_at: at });
  });
  toast.info(t(doc.kind === "row" ? "docs.rowDeleted" : "docs.deleted"), {
    label: t("common.undo"),
    run: () => restoreDoc(id),
  });
}

/** Sets values of a database row; null clears one. */
export function setRowProps(rowId: string, values: Fields) {
  const row = getRow("docs", rowId);
  if (!row) return;
  const next: Fields = { ...(row.props ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  send({ type: "doc.update", args: { id: rowId, props: values } }, (tx) =>
    tx.patch("docs", rowId, { props: next, updated_at: Date.now() }),
  );
}

export const keepVersion = (docId: string, label: string) =>
  mutate({ type: "doc.snapshot", args: { doc: docId, label } });

export const revertTo = (docId: string, versionId: string) =>
  mutate({ type: "doc.revert", args: { doc: docId, version: versionId } });

/** Replaces (or adds to) a page's content from Markdown; blocks that did not change are kept. */
export const writeMarkdown = (docId: string, markdown: string, mode: "replace" | "append" = "replace") =>
  mutate({ type: "doc.write", args: { doc: docId, markdown, mode } });

export interface NewDocComment {
  docId: string;
  blockId?: string;
  parentId?: string;
  body: string;
}

export function addComment({ docId, blockId, parentId, body }: NewDocComment) {
  const { me } = getState();
  const id = newId();
  const args: Changes["comment.create"] = { id, doc: docId, body };
  if (blockId) args.block = blockId;
  if (parentId) args.parent = parentId;
  send({ type: "comment.create", args }, (tx) =>
    tx.insert("comments", {
      id,
      doc_id: docId,
      subject_type: blockId ? "doc_block" : "doc",
      subject_id: blockId ?? docId,
      kind: "comment",
      parent_id: parentId,
      author_id: me?.user_id,
      body,
      created_at: Date.now(),
    }),
  );
}

export function resolveComment(comment: DocComment, resolved: boolean) {
  send({ type: "comment.update", args: { id: comment.id, resolved } }, (tx) =>
    tx.patch("comments", comment.id, { resolved_at: resolved ? Date.now() : null }),
  );
}

export function deleteComment(comment: DocComment) {
  send({ type: "comment.delete", args: { id: comment.id } }, (tx) =>
    tx.patch("comments", comment.id, { deleted_at: Date.now() }),
  );
}
