// Keeps the caret where it is when a block's text is replaced under it by
// someone else's edit: the same number of characters into the block, or its
// end if the text got shorter.

import { type BlockNoteEditor, getNodeById } from "@blocknote/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

interface SelectionClass {
  create(doc: unknown, anchor: number, head: number): unknown;
}

export function keepCursor(editor: Editor, blockId: string, run: () => void) {
  editor.transact((tr) => {
    const sel = tr.selection;
    const before = getNodeById(blockId, tr.doc);
    const text = before?.node.firstChild;
    const start = before ? before.posBeforeNode + 2 : 0;
    // Only when the caret is in this block's own text (not in a block nested under it).
    const inside = !!before && !!text && sel.from >= start - 1 && sel.to <= start + text.content.size + 1;
    run();
    if (!inside) return;
    const after = getNodeById(blockId, tr.doc);
    const now = after?.node.firstChild;
    if (!after || !now || !now.isTextblock) return;
    const base = after.posBeforeNode + 2;
    const clamp = (pos: number) => base + Math.max(0, Math.min(pos - start, now.content.size));
    try {
      const Sel = sel.constructor as unknown as SelectionClass;
      tr.setSelection(Sel.create(tr.doc, clamp(sel.anchor), clamp(sel.head)) as never);
    } catch {
      // The selection could not be put back (a table cell, an image): the editor's own mapping stands.
    }
  });
}
