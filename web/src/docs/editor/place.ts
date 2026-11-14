// Where a block that arrives from the server goes in the editor: its rank
// says where it sits among its siblings; it is put next to the nearest of
// them that is on screen.

import type { BlockNoteEditor } from "@blocknote/core";
import type { EdBlock } from "@/docs/editor/convert";
import type { Known } from "@/docs/editor/diff";
import type { BlockRow } from "@/docs/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

export function placeBlock(editor: Editor, known: Map<string, Known>, block: EdBlock, parent: string, row: BlockRow) {
  const sibs: { id: string; rank: string }[] = [{ id: row.id, rank: row.rank }];
  for (const [id, k] of known) {
    if (k.parent === parent && id !== row.id) sibs.push({ id, rank: k.rank });
  }
  sibs.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
  const at = sibs.findIndex((s) => s.id === row.id);
  const here = (id: string) => !!editor.getBlock(id) && (editor.getParentBlock(id)?.id ?? "") === parent;
  for (let i = at + 1; i < sibs.length; i++) {
    const id = (sibs[i] as { id: string }).id;
    if (here(id)) return void editor.insertBlocks([block as never], id, "before");
  }
  for (let i = at - 1; i >= 0; i--) {
    const id = (sibs[i] as { id: string }).id;
    if (here(id)) return void editor.insertBlocks([block as never], id, "after");
  }
  if (parent) {
    // The first block under its parent, as far as the server knows; blocks typed there and not yet sent stay below it.
    const p = editor.getBlock(parent) as unknown as EdBlock | undefined;
    if (!p) return;
    const first = p.children[0];
    if (first) editor.insertBlocks([block as never], first.id, "before");
    else editor.updateBlock(parent, { children: [block] } as never);
    return;
  }
  const first = (editor.document as unknown as EdBlock[])[0];
  if (first) editor.insertBlocks([block as never], first.id, "before");
}
