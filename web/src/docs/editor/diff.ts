// Works out what to tell the server after the person edits a page: the
// editor's document is compared with the last state the server is known to
// hold, block by block, and the difference becomes the ops of one doc.edit
// change (insert, update, move, delete). Nothing here touches the editor.

import { type EdBlock, signature, type Wire } from "@/docs/editor/convert";
import { spread } from "@/docs/editor/ranks";

/** What the server holds for one block, as far as this browser knows. */
export interface Known {
  parent: string;
  rank: string;
  /** The block's signature when it was last in step with the server. */
  sig: string;
  type: string;
  /** Whether the server's row has props (so clearing them must be sent). */
  props: boolean;
  /** The feed position of the last change to this block that was applied here. */
  seq: number;
}

export interface Op {
  op: "insert" | "update" | "move" | "delete";
  id?: string;
  block?: { id: string } & Wire;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  parent?: string;
  rank?: string;
}

/** One block of the editor's document, flattened. */
export interface Flat {
  id: string;
  parent: string;
  wire: Wire;
  sig: string;
}

const isBlank = (b: EdBlock) =>
  b.type === "paragraph" && b.children.length === 0 && (!Array.isArray(b.content) || b.content.length === 0);

/**
 * The editor's document as a list, parents before their children. The empty
 * paragraph the editor keeps at the end of a page is the person's place to
 * type, not content: it is left out until something is typed in it.
 */
export function flatten(doc: EdBlock[], toWire: (b: EdBlock) => Wire, known: Map<string, Known>): Flat[] {
  let top = doc;
  const last = doc[doc.length - 1];
  if (last && isBlank(last) && !known.has(last.id)) top = doc.slice(0, -1);
  const out: Flat[] = [];
  const walk = (list: EdBlock[], parent: string) => {
    for (const b of list) {
      const wire = toWire(b);
      out.push({ id: b.id, parent, wire, sig: signature(wire) });
      walk(b.children, b.id);
    }
  };
  walk(top, "");
  return out;
}

/**
 * Of the blocks already under this parent on the server, the largest set
 * whose ranks are already in the order the editor shows. Those stay put;
 * every other block of the list gets a new rank between them.
 */
function settled(ids: string[], parent: string, known: Map<string, Known>): Set<string> {
  const cand: { id: string; rank: string }[] = [];
  for (const id of ids) {
    const k = known.get(id);
    if (k && k.parent === parent) cand.push({ id, rank: k.rank });
  }
  // Longest strictly increasing run of ranks (patience sorting).
  const tails: number[] = [];
  const prev: number[] = new Array<number>(cand.length).fill(-1);
  for (let i = 0; i < cand.length; i++) {
    const rank = (cand[i] as { rank: string }).rank;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cand[tails[mid] as number] as { rank: string }).rank < rank) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const keep = new Set<string>();
  for (let i = tails.length ? (tails[tails.length - 1] as number) : -1; i >= 0; i = prev[i] as number) {
    keep.add((cand[i] as { id: string }).id);
  }
  return keep;
}

export interface Diff {
  ops: Op[];
  /** The known state of every block that was sent, as it will be once the server takes the ops. */
  next: Map<string, Omit<Known, "seq">>;
  deleted: string[];
}

export function diff(flat: Flat[], known: Map<string, Known>): Diff {
  const ops: Op[] = [];
  const next = new Map<string, Omit<Known, "seq">>();
  const lists = new Map<string, string[]>();
  const byId = new Map<string, Flat>();
  for (const f of flat) {
    byId.set(f.id, f);
    const list = lists.get(f.parent) ?? [];
    list.push(f.id);
    lists.set(f.parent, list);
  }

  // Where every block goes: a new rank for the ones that are new or moved.
  const rankOf = new Map<string, string>();
  for (const [parent, ids] of lists) {
    const keep = settled(ids, parent, known);
    for (let i = 0; i < ids.length;) {
      const id = ids[i] as string;
      if (keep.has(id)) {
        i++;
        continue;
      }
      let end = i;
      while (end < ids.length && !keep.has(ids[end] as string)) end++;
      const lo = i > 0 ? (rankOf.get(ids[i - 1] as string) ?? known.get(ids[i - 1] as string)?.rank ?? "") : "";
      const hi = end < ids.length ? (known.get(ids[end] as string)?.rank ?? "") : "";
      const ranks = spread(lo, hi, end - i);
      for (let j = i; j < end; j++) rankOf.set(ids[j] as string, ranks[j - i] as string);
      i = end;
    }
  }

  // Parents come before their children in `flat`, so an insert finds its parent there.
  for (const f of flat) {
    const k = known.get(f.id);
    const rank = rankOf.get(f.id);
    const hasProps = !!f.wire.props;
    if (!k) {
      ops.push({ op: "insert", block: { id: f.id, ...f.wire }, parent: f.parent, rank });
      next.set(f.id, { parent: f.parent, rank: rank as string, sig: f.sig, type: f.wire.type, props: hasProps });
      continue;
    }
    let touched = false;
    if (rank !== undefined) {
      ops.push({ op: "move", id: f.id, parent: f.parent, rank });
      touched = true;
    }
    if (k.sig !== f.sig) {
      const op: Op = { op: "update", id: f.id, type: f.wire.type };
      // Props and content are sent whole. A block that lost its last prop, or
      // became a kind with no text, has to say so or the old value would stay.
      if (hasProps || k.props) op.props = f.wire.props ?? {};
      if (f.wire.content !== undefined) op.content = f.wire.content;
      else if (k.type !== f.wire.type) op.content = [];
      ops.push(op);
      touched = true;
    }
    if (touched)
      next.set(f.id, {
        parent: f.parent,
        rank: rank ?? k.rank,
        sig: f.sig,
        type: f.wire.type,
        props: hasProps || k.props,
      });
  }

  const deleted: string[] = [];
  for (const id of known.keys()) {
    if (!byId.has(id)) deleted.push(id);
  }
  for (const id of deleted) ops.push({ op: "delete", id });
  return { ops, next, deleted };
}
