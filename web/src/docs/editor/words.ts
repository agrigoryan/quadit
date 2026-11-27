// The words of a page a comment thread is on, as the server counts them
// (internal/md, comments.go): characters (code points) of a block's text,
// a mention or a chip counting as its label. The selection a new thread is
// started on is told to the server this way, and the words a thread is on
// are read back from the style that marks them (editor/schema.tsx).

import type { AnyEditor } from "@/docs/editor/sync";
import { type EdBlock, plainText } from "@/docs/editor/convert";

/** Words of a page: where they start in one block and end in the same or a later one, and the words themselves. */
export interface Words {
  block: string;
  start: number;
  end: number;
  /** The block they end in, when that is a later one than `block`. */
  endBlock?: string;
  /** What they read, the parts in different blocks on lines of their own. */
  quote: string;
}

/** A node of the editor's document, as ProseMirror has it. */
type PmNode = AnyEditor["prosemirrorState"]["doc"];

/** What an inline thing that is not text counts as in a block's text. */
function label(node: PmNode): string {
  const attr = (key: string) => {
    const value: unknown = node.attrs[key];
    return typeof value === "string" ? value : "";
  };
  switch (node.type.name) {
    case "mention":
      return `@${attr("handle").replace(/^@/, "")}`;
    case "taskChip":
    case "decisionChip":
      return attr("key");
    case "pageLink":
      return `doc:${attr("doc")}`;
    case "hardBreak":
      return "\n";
    default:
      return "";
  }
}

/** A textblock's text as the server reads it, and how many of its characters come before a position in it. */
function textOf(block: PmNode): { text: string; at: (pos: number) => number } {
  const pieces: { offset: number; text: string; isText: boolean }[] = [];
  block.forEach((child, offset) => {
    pieces.push({ offset, text: child.isText ? (child.text ?? "") : label(child), isText: child.isText });
  });
  const count = (s: string) => Array.from(s).length;
  return {
    text: pieces.map((p) => p.text).join(""),
    at(pos) {
      let n = 0;
      for (const p of pieces) {
        if (pos <= p.offset) break;
        n += count(p.isText ? p.text.slice(0, pos - p.offset) : p.text);
      }
      return n;
    },
  };
}

/**
 * The words the editor's selection holds, counted as the server counts
 * them; undefined for no selection, one that is only spaces, or one in a
 * code block or a table alone (their text carries no markers). Over several
 * blocks, the parts in code blocks and tables are left out of the quote, as
 * the server leaves them out.
 */
export function selectedWords(editor: AnyEditor): Words | undefined {
  const { selection, doc } = editor.prosemirrorState;
  if (selection.empty) return undefined;
  const parts: { block: string; start: number; end: number; text: string }[] = [];
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name !== "blockContainer") return true;
    const content = node.firstChild;
    if (!content?.isTextblock || content.type.name === "codeBlock") return true;
    const inside = pos + 2; // past the block's start and its content's
    const from = Math.max(selection.from, inside) - inside;
    const to = Math.min(selection.to, inside + content.content.size) - inside;
    if (from >= to) return true;
    const { text, at } = textOf(content);
    const start = at(from);
    const end = at(to);
    if (start < end)
      parts.push({ block: String(node.attrs.id), start, end, text: Array.from(text).slice(start, end).join("") });
    return true;
  });
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return undefined;
  const quote = parts.map((p) => p.text).join("\n");
  if (!quote.trim()) return undefined;
  const words: Words = { block: first.block, start: first.start, end: last.end, quote };
  if (last.block !== first.block) words.endBlock = last.block;
  return words;
}

/** The thread ids a style value names. */
export const threadsIn = (value: unknown): string[] =>
  typeof value === "string" ? value.split(" ").filter(Boolean) : [];

/** What the page reads for its threads (readThreads). */
export interface ThreadReading {
  /** Every block's id, in reading order. */
  order: string[];
  /** The text of each block asked for; undefined for one not in the page. */
  texts: Map<string, string | undefined>;
  /** The words each thread asked for is on now, each stretch apart joined with an ellipsis; undefined when they are nowhere in the page. */
  words: Map<string, string | undefined>;
}

/**
 * Reads, in one walk of the page's blocks, what its comment threads need:
 * the blocks' order, the text of the blocks asked for, and the words of the
 * threads asked for. Done once a frame at most while the page is typed in,
 * for all the threads at once.
 */
export function readThreads(document: EdBlock[], blocks: string[], threads: string[]): ThreadReading {
  const order: string[] = [];
  const texts = new Map<string, string | undefined>(blocks.map((id) => [id, undefined]));
  const stretches = new Map<string, string[]>(threads.map((id) => [id, []]));
  const walk = (list: EdBlock[]) => {
    for (const block of list) {
      order.push(block.id);
      if (texts.has(block.id)) texts.set(block.id, plainText(block.content));
      // The threads whose stretch the last piece of text carried on.
      let open = new Set<string>();
      const inline = (items: unknown) => {
        if (!Array.isArray(items)) return;
        for (const item of items as {
          type?: string;
          text?: string;
          styles?: Record<string, unknown>;
          content?: unknown;
        }[]) {
          if (item.type === "link") {
            inline(item.content);
            continue;
          }
          if (item.type !== "text") continue; // a chip between two stretches does not break them
          const on = new Set(threadsIn(item.styles?.comment).filter((id) => stretches.has(id)));
          for (const id of on) {
            const found = stretches.get(id) ?? [];
            if (open.has(id)) found[found.length - 1] += item.text ?? "";
            else found.push(item.text ?? "");
          }
          if (on.size || item.text) open = on;
        }
      };
      inline(block.content);
      walk(block.children);
    }
  };
  walk(document);
  const words = new Map([...stretches].map(([id, found]) => [id, found.length ? found.join(" … ") : undefined]));
  return { order, texts, words };
}
