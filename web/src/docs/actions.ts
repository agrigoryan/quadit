// Every way the app changes a page, in one place. Each function shows the
// change at once and sends it as a named change (see data/mutate.ts), and
// is remembered with its opposite, so Cmd+Z takes it back (data/undo.ts).
// What a page says is the editor's own to undo; comments and kept versions
// are not undone from here.

import type { Changes } from "@/types/changes.gen";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { commentFiles } from "@/data/comment-files";
import { mutate, send, type Tx } from "@/data/mutate";
import { type Batch, forget, remember, sendUndoable, undo } from "@/data/undo";
import { rankBetween } from "@/lib/rank";
import { getLookupEvenIfGone, getRow, getRowEvenIfGone, getRows } from "@/data/selectors";
import { isNotFound, readError } from "@/data/query";
import { getState } from "@/data/store";
import { toast } from "@/lib/toast";
import { sameProjectBelow } from "@/docs/data";
import { forgetLink, loadPage } from "@/docs/store";
import type { Words } from "@/docs/editor/words";
import { type Doc, type DocComment, type DocKind, OPTION_COLORS } from "@/types/docs";
import type { FileRow } from "@/types/core";

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

/** What a page is called when a step on it is undone: its title, in quotes. */
const named = (doc: Pick<Doc, "title">) => t("undo.titled", { title: doc.title || t("docs.untitled") });

/** The batch that puts a page and those under it in the trash, or takes them out. */
function trashing(id: string, ids: string[], put: boolean): Batch {
  return {
    changes: [{ type: put ? "doc.delete" : "doc.restore", args: { id } }],
    show: (tx) => {
      for (const each of ids) tx.patch("docs", each, { deleted_at: put ? Date.now() : null });
    },
  };
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
  const made = remember(
    t(kind === "row" ? "undo.row.create" : "undo.doc.create"),
    () => sendBatch(trashing(id, [id], true)),
    () => sendBatch(trashing(id, [id], false)),
    { warning: t("undo.warn.created") },
  );
  mutate({ type: "doc.create", args }, (tx) =>
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
  ).catch(() => forget(made));
  return id;
}

const sendBatch = (batch: Batch) => mutate(batch.changes, batch.show);

/** Sets simple fields of a page: title, icon, cover. */
export function updateDoc(id: string, fields: Partial<Pick<Doc, "title" | "icon" | "cover">>) {
  const doc = getRow("docs", id);
  if (!doc) return;
  const changed: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if ((doc as Fields)[key] !== value && !(value === "" && (doc as Fields)[key] === undefined)) changed[key] = value;
  }
  if (Object.keys(changed).length === 0) return;
  // What the row holds for a field, as doc.update takes it ("" clears an icon or a cover) and as the row keeps it.
  const shown = (key: string, value: unknown) => (value === "" && key !== "title" ? null : value);
  const local: Fields = {};
  const back: Fields = {};
  const before: Fields = {};
  for (const [key, value] of Object.entries(changed)) {
    local[key] = shown(key, value);
    back[key] = (doc as Fields)[key] ?? "";
    before[key] = shown(key, back[key]);
  }
  sendUndoable(
    t("undo.doc.change", { what: named(doc) }),
    {
      changes: [{ type: "doc.update", args: { id, ...changed } }],
      show: (tx) => tx.patch("docs", id, { ...local, updated_at: Date.now() }),
    },
    {
      changes: [{ type: "doc.update", args: { id, ...back } }],
      show: (tx) => tx.patch("docs", id, { ...before, updated_at: Date.now() }),
    },
    // A title is saved as it is typed: the whole of the typing is one step.
    { sameAs: `doc:${id}:${Object.keys(changed).join()}` },
  );
}

/** Moves a page in the tree: under another page (or to the top), at a place among its new siblings. */
export function moveDoc(id: string, parentId: string | null, rank: string) {
  const doc = getRow("docs", id);
  if (!doc) return;
  const args: Changes["doc.update"] = { id, rank };
  const back: Changes["doc.update"] = { id, rank: doc.rank };
  if ((doc.parent_id ?? null) !== parentId) {
    args.parent = parentId;
    back.parent = doc.parent_id ?? null;
  }
  sendUndoable(
    t("undo.doc.move", { what: named(doc) }),
    { changes: [{ type: "doc.update", args }], show: (tx) => tx.patch("docs", id, { parent_id: parentId, rank }) },
    {
      changes: [{ type: "doc.update", args: back }],
      show: (tx) => tx.patch("docs", id, { parent_id: doc.parent_id ?? null, rank: doc.rank }),
    },
  );
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
  const forward: Batch = { changes: [{ type: "doc.update", args }], show: (tx) => tx.patch("docs", id, local) };
  const doc = getRow("docs", id);
  // Making a page private makes the one who does it its owner: only the owner's own change can be put back as it was.
  if (!doc || (doc.owner_id && doc.owner_id !== me?.user_id)) {
    send(forward.changes, forward.show);
    return;
  }
  const back: Changes["doc.update"] = { id };
  const before: Fields = {};
  if ("private" in args) {
    back.private = !!doc.owner_id;
    before.owner_id = doc.owner_id ?? null;
  }
  if ("shared_with" in args) {
    back.shared_with = doc.shared_with ?? [];
    before.shared_with = doc.shared_with ?? null;
  }
  sendUndoable(t("undo.doc.share", { what: named(doc) }), forward, {
    changes: [{ type: "doc.update", args: back }],
    show: (tx) => tx.patch("docs", id, before),
  });
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
  const to = (project: string | null): Batch => ({
    changes: [{ type: "doc.update", args: { id, project } }],
    show: (tx) => {
      for (const each of [doc, ...along]) tx.patch("docs", each.id, { project_id: project });
    },
  });
  sendUndoable(t("undo.doc.project", { what: named(doc) }), to(projectId), to(doc.project_id ?? null));
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
  const restore = () =>
    sendBatch(trashing(id, ids, false)).then(() => {
      // A page the workspace copy never had (deleted before this visit) is fetched whole.
      if (known) return;
      loadPage(id).catch((err: unknown) => {
        // Not there for this person after all: there is nothing to show. Anything else, say.
        const why = readError(err);
        if (why && !isNotFound(err)) toast.error(t("docs.trash.restoredNotLoaded", { why }));
      });
    });
  const what = known ? named(known) : t("undo.doc.aPage");
  const done = remember(t("undo.restore", { what }), () => sendBatch(trashing(id, ids, true)), restore);
  // Refused: mutate has said why and put the page back in the trash.
  restore().catch(() => forget(done));
}

/** Moves a page and the pages under it to the trash, with a way back. */
export function trashDoc(id: string) {
  const doc = getRow("docs", id);
  if (!doc) return;
  const ids = subtree(id).map((d) => d.id);
  const done = sendUndoable(t("undo.delete", { what: named(doc) }), trashing(id, ids, true), trashing(id, ids, false));
  toast.info(t(doc.kind === "row" ? "docs.rowDeleted" : "docs.deleted"), {
    label: t("common.undo"),
    run: () => void undo(done),
  });
}

/**
 * Sets values of a database row; null clears one. A select's value may name
 * an option the property does not have yet: the server adds it to the
 * property, so it shows there at once too, in the next colour.
 */
export function setRowProps(rowId: string, values: Fields) {
  const row = getRow("docs", rowId);
  if (!row) return;
  const next: Fields = { ...(row.props ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  const before: Fields = {};
  for (const key of Object.keys(values)) before[key] = row.props?.[key] ?? null;
  const forward: Batch = {
    changes: [{ type: "doc.update", args: { id: rowId, props: values } }],
    show: addingOptions,
  };
  const back: Batch = {
    changes: [{ type: "doc.update", args: { id: rowId, props: before } }],
    show: (tx) => tx.patch("docs", rowId, { props: row.props ?? null, updated_at: Date.now() }),
  };
  // A cell typed in is saved as it goes: the typing is one step.
  sendUndoable(t("undo.row.change", { what: named(row) }), forward, back, {
    sameAs: `row:${rowId}:${Object.keys(values).join()}`,
  });

  /** Shows the row's new values, and the options they add to their properties (which stay when the edit is undone). */
  function addingOptions(tx: Tx) {
    tx.patch("docs", rowId, { props: next, updated_at: Date.now() });
    for (const [key, value] of Object.entries(values)) {
      const prop = getRow("properties", key);
      if (prop?.type !== "select" && prop?.type !== "multi_select") continue;
      const options = [...(prop.config?.options ?? [])];
      for (const name of Array.isArray(value) ? value : [value]) {
        if (typeof name === "string" && name && !options.some((o) => o.name === name))
          options.push({ name, color: OPTION_COLORS[options.length % OPTION_COLORS.length] });
      }
      if (options.length > (prop.config?.options?.length ?? 0))
        tx.patch("properties", prop.id, { config: { ...prop.config, options } });
    }
  }
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
  /** The words of the page it is on; the server puts the thread's marker on them. */
  words?: Words;
  parentId?: string;
  body: string;
  /** Uploaded files, attached to the comment. */
  files?: FileRow[];
}

/** Posts a comment on a page, a block or words of it, or a reply. It shows at once, with its files. */
export function addComment({ docId, blockId, words, parentId, body, files = [] }: NewDocComment) {
  const { me } = getState();
  const id = newId();
  const attached = commentFiles(files, id);
  const args: Changes["comment.create"] = { id, doc: docId, body };
  const block = words?.block ?? blockId;
  if (block) args.block = block;
  if (words) {
    args.quote = words.quote;
    args.start = words.start;
    args.end = words.end;
    if (words.endBlock) args.end_block = words.endBlock;
  }
  if (parentId) args.parent = parentId;
  if (attached.args) args.attachments = attached.args;
  send({ type: "comment.create", args }, (tx) => {
    tx.insert("comments", {
      id,
      doc_id: docId,
      subject_type: block ? "doc_block" : "doc",
      subject_id: block ?? docId,
      kind: "comment",
      parent_id: parentId,
      author_id: me?.user_id,
      body,
      quote: words?.quote,
      created_at: Date.now(),
    });
    attached.show(tx);
  });
}

export function resolveComment(comment: DocComment, resolved: boolean) {
  const set = (on: boolean): Batch => ({
    changes: [{ type: "comment.update", args: { id: comment.id, resolved: on } }],
    show: (tx) => tx.patch("comments", comment.id, { resolved_at: on ? Date.now() : null }),
  });
  sendUndoable(t(resolved ? "undo.comment.resolve" : "undo.comment.reopen"), set(resolved), set(!resolved));
}

export function deleteComment(comment: DocComment) {
  send({ type: "comment.delete", args: { id: comment.id } }, (tx) =>
    tx.patch("comments", comment.id, { deleted_at: Date.now() }),
  );
}

/**
 * Takes a task's link to a page off, from the page. The task's copy of the
 * link goes at once; the pages forget it once the server has taken it off
 * (its list was read with the page, and the link need not be in the copy).
 */
export async function unlinkTask(linkId: string): Promise<void> {
  try {
    await mutate({ type: "link.remove", args: { id: linkId } }, (tx) =>
      tx.patch("links", linkId, { deleted_at: Date.now() }),
    );
  } catch {
    return; // refused: mutate has said so and put the link back
  }
  forgetLink(linkId);
}
