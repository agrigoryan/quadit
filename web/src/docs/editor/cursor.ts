// Keeps the caret where it is when a block's text is replaced under it by
// someone else's edit: at the same place in the text that did not change
// (text added before the caret pushes it along), or at the edge of what was
// rewritten.

import { type BlockNoteEditor, getNodeById } from "@blocknote/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

interface SelectionClass {
  create(doc: unknown, anchor: number, head: number): unknown;
}

interface TextNode {
  content: { size: number };
  textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string;
}

/** A block's text with one character per position, so offsets in it are offsets in the document. */
const flat = (node: TextNode) => node.textBetween(0, node.content.size, undefined, "￼");

/** Where an offset in `before` lands in `after`, given the two share a start and an end. */
function shift(offset: number, before: string, after: string): number {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  if (offset <= head) return offset;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  if (offset >= before.length - tail) return offset + after.length - before.length;
  return after.length - tail;
}

export function keepCursor(editor: Editor, blockId: string, run: () => void) {
  editor.transact((tr) => {
    const sel = tr.selection;
    const before = getNodeById(blockId, tr.doc);
    const text = before?.node.firstChild;
    const start = before ? before.posBeforeNode + 2 : 0;
    // Only when the caret is in this block's own text (not in a block nested under it).
    const inside = !!before && !!text && text.isTextblock && sel.from >= start && sel.to <= start + text.content.size;
    const was = inside && text ? flat(text) : "";
    run();
    if (!inside) return;
    const after = getNodeById(blockId, tr.doc);
    const now = after?.node.firstChild;
    if (!after || !now || !now.isTextblock) return;
    const base = after.posBeforeNode + 2;
    const is = flat(now);
    const place = (pos: number) => base + Math.max(0, Math.min(shift(pos - start, was, is), now.content.size));
    try {
      const Sel = sel.constructor as unknown as SelectionClass;
      tr.setSelection(Sel.create(tr.doc, place(sel.anchor), place(sel.head)) as never);
    } catch {
      // The selection could not be put back (a table cell, an image): the editor's own mapping stands.
    }
  });
}
