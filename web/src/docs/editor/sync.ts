// Keeps one open page in step with the server, block by block.
//
// Going out: the editor's document is compared with what the server is
// known to hold (editor/diff.ts) a moment after the person stops typing,
// and the difference is sent as one doc.edit change through mutate(), so it
// queues offline and is retried under the same change id.
//
// Coming in: a doc.edited event from someone else carries the blocks it
// wrote and the ids it removed. Only those blocks are touched in the
// editor. A block the person has unsent edits in is left as it is: their
// edit goes out next and, being later, wins. A block whose edit is on its
// way keeps the remote version aside until the server answers, then the
// later of the two stays. Removing a block always wins.

import type { BlockNoteEditor } from "@blocknote/core";
import { errorMessage } from "@/lib/api";
import { newId } from "@/lib/ids";
import { mutate } from "@/lib/mutate";
import { getRowEvenIfGone } from "@/lib/selectors";
import { onEvents, useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { FeedEvent } from "@/lib/types";
import { type BlockSchemaLike, type EdBlock, rowsToEditor, signature, toEditor, toWire } from "@/docs/editor/convert";
import { diff, flatten, type Known } from "@/docs/editor/diff";
import { keepCursor } from "@/docs/editor/cursor";
import { placeBlock } from "@/docs/editor/place";
import { loadPage } from "@/docs/store";
import type { BlockRow } from "@/lib/types-docs";

// oxlint-disable-next-line typescript/no-explicit-any -- BlockNote's editor type is generic over the page's schema, and this works with any schema
export type AnyEditor = BlockNoteEditor<any, any, any>;

/** A signature no block has: marks a block whose local text is known to differ from the server's. */
const STALE = "\u0000stale";
const DEBOUNCE_MS = 350;

export type SaveState = "saved" | "saving";

export class DocSync {
  private known = new Map<string, Known>();
  private own = new Set<string>();
  private inflight = new Map<string, number>();
  private held = new Map<string, BlockRow>();
  /** Ids removed on the server: a block that comes back locally (undo) needs a new one. */
  private graveyard = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private applying = false;
  private pending = 0;
  private seq: number;
  private dead = false;
  private stops: (() => void)[] = [];
  private schema: BlockSchemaLike;

  constructor(
    private editor: AnyEditor,
    private docId: string,
    rows: BlockRow[],
    seq: number,
    private onState: (state: SaveState) => void = () => {},
  ) {
    this.schema = editor.schema.blockSchema;
    this.seq = seq;
    for (const row of rows) this.remember(row);
    this.stops.push(editor.onChange(() => !this.applying && this.schedule()));
    this.stops.push(onEvents(this.onFeed));
    this.stops.push(useStore.subscribe(this.onStore));
    window.addEventListener("pagehide", this.flush);
    this.stops.push(() => window.removeEventListener("pagehide", this.flush));
  }

  /** Sends what is unsent and stops following. */
  destroy() {
    this.flush();
    this.dead = true;
    for (const stop of this.stops) stop();
  }

  private doc(): EdBlock[] {
    return this.editor.document;
  }

  private sigOf(block: EdBlock): string {
    return signature(toWire(block, this.schema));
  }

  /** Records a server row as the known state of its block, as the editor now shows it. */
  private remember(row: BlockRow) {
    const block = this.editor.getBlock(row.id) as unknown as EdBlock | undefined; // BlockNote types blocks by schema generics
    if (!block) return; // not on screen (its parent is gone): leave it alone on the server too
    this.known.set(row.id, {
      parent: row.parent_id ?? "",
      rank: row.rank,
      sig: this.sigOf(block),
      type: block.type,
      props: row.props != null,
      seq: row.updated_seq,
    });
  }

  // ---- going out ----

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.flush, DEBOUNCE_MS);
  }

  private setPending(by: number) {
    this.pending += by;
    this.onState(this.pending > 0 ? "saving" : "saved");
  }

  /** Sends the difference between the editor and the known server state, now. */
  flush = () => {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dead || !this.editor.isEditable) return;
    this.rehome();
    const flat = flatten(this.doc(), (b) => toWire(b, this.schema), this.known);
    const d = diff(flat, this.known);
    if (d.ops.length === 0) return;

    const changeId = newId();
    this.own.add(changeId);
    const touched = [...d.next.keys(), ...d.deleted];
    for (const id of d.deleted) {
      this.known.delete(id);
      this.graveyard.add(id);
    }
    for (const [id, next] of d.next) this.known.set(id, { ...next, seq: this.known.get(id)?.seq ?? 0 });
    for (const id of touched) this.inflight.set(id, (this.inflight.get(id) ?? 0) + 1);
    this.setPending(1);

    mutate({ id: changeId, type: "doc.edit", args: { doc: this.docId, ops: d.ops } }, undefined, { quiet: true })
      .then((results) => {
        this.setPending(-1);
        this.ack(touched, results[0]?.seq ?? 0);
      })
      .catch((err: unknown) => {
        // Refused: what is on screen is no longer what the server has. Start again from the server's page.
        this.setPending(-1);
        if (this.dead) return;
        toast.error(errorMessage(err));
        void this.resync(true);
      });
  };

  /** A block brought back by undo after its removal was sent cannot reuse its id: give it a fresh one. */
  private rehome() {
    if (this.graveyard.size === 0) return;
    const stale: EdBlock[] = [];
    const walk = (list: EdBlock[]) => {
      for (const b of list) {
        if (this.graveyard.has(b.id) && !this.known.has(b.id)) stale.push(b);
        else walk(b.children);
      }
    };
    walk(this.doc());
    if (stale.length === 0) return;
    const fresh = (b: EdBlock): EdBlock => ({ ...b, id: newId(), children: b.children.map(fresh) });
    this.quietly(() => {
      for (const b of stale) this.editor.replaceBlocks([b.id], [fresh(b)] as never[]);
    });
  }

  private ack(touched: string[], seq: number) {
    this.seq = Math.max(this.seq, seq);
    const later: BlockRow[] = [];
    for (const id of touched) {
      const left = (this.inflight.get(id) ?? 1) - 1;
      if (left > 0) {
        this.inflight.set(id, left);
        continue;
      }
      this.inflight.delete(id);
      const k = this.known.get(id);
      if (k) k.seq = Math.max(k.seq, seq);
      const held = this.held.get(id);
      this.held.delete(id);
      // Someone's edit of the same block landed after ours: theirs is what the server has.
      if (held && held.updated_seq > seq) later.push(held);
    }
    if (later.length && !this.dead) this.remote(later, []);
  }

  // ---- coming in ----

  private onFeed = (events: FeedEvent[]) => {
    for (const ev of events) {
      if (ev.type !== "doc.edited" || ev.entity_id !== this.docId || this.own.has(ev.change_id)) continue;
      this.seq = Math.max(this.seq, ev.seq);
      let rows = (ev.data.blocks as BlockRow[] | undefined) ?? [];
      // A page brought back from a backup arrives whole, its blocks stamped as they were when the
      // backup was taken: older than what is on screen, yet they are what the page now is.
      if (ev.data.from_backup)
        rows = rows.map((row) => ({ ...row, updated_seq: Math.max(row.updated_seq ?? 0, ev.seq) }));
      this.remote(rows, (ev.data.deleted as string[] | undefined) ?? []);
    }
  };

  /** After a gap in the feed the page may have moved on without events: fetch it and take the differences. */
  private onStore = () => {
    if (this.dead) return;
    setTimeout(() => {
      // A page put in the trash while open is still the page on screen.
      const doc = getRowEvenIfGone("docs", this.docId);
      if (this.dead || this.pending > 0 || !doc || (doc.content_seq ?? 0) <= this.seq) return;
      this.seq = doc.content_seq ?? 0;
      void this.resync(false);
    }, 200);
  };

  /** Runs editor changes that are not the person's: not sent back, not undone by their undo. */
  private quietly(run: () => void) {
    this.applying = true;
    try {
      this.editor.transact((tr) => {
        tr.setMeta("addToHistory", false);
        run();
      });
    } finally {
      this.applying = false;
    }
  }

  private remote(rows: BlockRow[], deleted: string[]) {
    this.quietly(() => {
      for (const id of deleted) {
        this.known.delete(id);
        this.held.delete(id);
        this.graveyard.add(id);
        if (this.editor.getBlock(id)) this.editor.removeBlocks([id]);
      }
      // A block goes in after the block it sits in.
      let left = rows.filter((r) => !r.deleted_at);
      for (let pass = 0; left.length && pass < 50; pass++) {
        const wait: BlockRow[] = [];
        for (const row of left) {
          if (row.parent_id && !this.editor.getBlock(row.parent_id) && left.some((r) => r.id === row.parent_id))
            wait.push(row);
          else this.take(row);
        }
        if (wait.length === left.length) break;
        left = wait;
      }
    });
  }

  private take(row: BlockRow) {
    const k = this.known.get(row.id);
    if (k && k.seq >= row.updated_seq) return;
    this.graveyard.delete(row.id);
    if (this.inflight.has(row.id)) {
      this.held.set(row.id, row);
      return;
    }
    const cur = this.editor.getBlock(row.id) as unknown as EdBlock | undefined; // BlockNote types blocks by schema generics
    if (cur && k && this.sigOf(cur) !== k.sig) {
      // Unsent local edits in this block: keep them; they are sent next and win.
      this.known.set(row.id, {
        parent: row.parent_id ?? "",
        rank: row.rank,
        sig: STALE,
        type: row.type,
        props: row.props != null,
        seq: row.updated_seq,
      });
      this.schedule();
      return;
    }
    const parent = row.parent_id ?? "";
    const block = toEditor(row, this.schema);
    if (cur && k && k.parent === parent && k.rank === row.rank) {
      const { id: _id, ...update } = block;
      keepCursor(this.editor, row.id, () => this.editor.updateBlock(row.id, update as never));
    } else {
      if (cur) this.editor.removeBlocks([row.id]);
      placeBlock(this.editor, this.known, { ...block, children: cur?.children ?? [] }, parent, row);
    }
    this.remember(row);
  }

  /**
   * Fetches the page again. `hard` replaces everything on screen with the
   * server's page (after a refused edit); otherwise the fetched blocks are
   * taken like remote edits, so unsent local edits stay.
   */
  private async resync(hard: boolean) {
    let rows: BlockRow[];
    try {
      const data = await loadPage(this.docId);
      rows = data.blocks;
      this.seq = Math.max(this.seq, data.seq);
    } catch {
      return;
    }
    if (this.dead) return;
    if (!hard) {
      const live = new Set(rows.map((r) => r.id));
      this.remote(
        rows,
        [...this.known.keys()].filter((id) => !live.has(id) && !this.inflight.has(id)),
      );
      return;
    }
    clearTimeout(this.timer);
    this.known.clear();
    this.held.clear();
    this.inflight.clear();
    const blocks = rowsToEditor(rows, this.schema);
    this.quietly(() =>
      this.editor.replaceBlocks(this.editor.document, (blocks.length ? blocks : [{ type: "paragraph" }]) as never[]),
    );
    for (const row of rows) this.remember(row);
  }
}
