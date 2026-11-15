// Between the server's blocks and the editor's. The server keeps a block the
// way Markdown conversion writes it (internal/md): only the props that are
// set, no empty `styles`, table cells as plain lists of inline content. The
// editor wants every prop spelled out. Going to the server we strip a block
// back to that short form, so a page written by an agent and the same page
// edited here stay the same blocks to the server.

import { chipify } from "@/docs/editor/refs";
import type { BlockRow, BlockTree } from "@/docs/types";

type Obj = Record<string, unknown>;

/** A block as the editor holds it, loosely typed: we handle every block type alike. */
export interface EdBlock {
  id: string;
  type: string;
  props: Obj;
  content?: unknown;
  children: EdBlock[];
}

/** What is sent for a block: its type and the short form of its props and content. */
export interface Wire {
  type: string;
  props?: Obj;
  content?: unknown;
}

/** The editor's block schema: which types exist and each prop's default. */
export type BlockSchemaLike = Record<string, { propSchema: Record<string, { default?: unknown }>; content: string }>;

// Inline things that are not text have other names in the editor ("doc" is
// taken there by the document itself).
// A decision carries the text the server reads it by, "SVA-7#2", as its key.
const TO_EDITOR: Record<string, string> = { mention: "mention", task: "taskChip", decision: "decisionChip", doc: "pageLink" };
const TO_SERVER: Record<string, string> = { mention: "mention", taskChip: "task", decisionChip: "decision", pageLink: "doc" };
const CHIP_PROP: Record<string, string> = { mention: "handle", task: "key", decision: "key", doc: "doc" };

/** Props a block always carries on the server, even at their default (as Markdown conversion writes them). */
const ALWAYS: Record<string, string[]> = { heading: ["level"], checkListItem: ["checked"] };

const CELL_DEFAULTS: Obj = { backgroundColor: "default", textColor: "default", textAlignment: "left", colspan: 1, rowspan: 1 };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ---- server -> editor ----

/** Inline content for the editor. `rich` text also gets chips for the things it names (editor/refs.ts). */
function inlineIn(content: unknown, rich = true): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return [];
  const out: unknown[] = [];
  for (const raw of content) {
    if (!isObj(raw)) continue;
    const type = String(raw.type ?? "text");
    if (type === "text") {
      const styles = isObj(raw.styles) ? raw.styles : {};
      if (rich) out.push(...chipify(String(raw.text ?? ""), styles));
      else out.push({ type: "text", text: String(raw.text ?? ""), styles });
    } else if (type === "link") {
      out.push({ type: "link", href: String(raw.href ?? ""), content: inlineIn(raw.content, false) });
    } else if (TO_EDITOR[type] && isObj(raw.props)) {
      const prop = CHIP_PROP[type] as string;
      out.push({ type: TO_EDITOR[type], props: { [prop]: String(raw.props[prop] ?? "").replace(/^@/, "") } });
    } else if (raw.text) {
      out.push({ type: "text", text: String(raw.text), styles: {} });
    }
  }
  return out;
}

function tableIn(content: unknown): unknown {
  const rows = isObj(content) && Array.isArray(content.rows) ? content.rows : [];
  const out: Obj = {
    type: "tableContent",
    rows: rows.map((row) => ({
      cells: (isObj(row) && Array.isArray(row.cells) ? row.cells : []).map((cell) =>
        isObj(cell) ? { type: "tableCell", props: { ...CELL_DEFAULTS, ...(isObj(cell.props) ? cell.props : {}) }, content: inlineIn(cell.content) } : inlineIn(cell),
      ),
    })),
  };
  if (isObj(content)) {
    if (Array.isArray(content.columnWidths)) out.columnWidths = content.columnWidths;
    if (typeof content.headerRows === "number") out.headerRows = content.headerRows;
    if (typeof content.headerCols === "number") out.headerCols = content.headerCols;
  }
  return out;
}

/** One server block as the editor takes it, without its nested blocks. */
export function toEditor(block: Pick<BlockRow, "id" | "type" | "props" | "content">, schema: BlockSchemaLike): Omit<EdBlock, "children"> {
  const spec = schema[block.type];
  if (!spec) {
    // A kind of block this editor does not know: show its text.
    return { id: block.id, type: "paragraph", props: defaultsOf(schema.paragraph), content: inlineIn(block.content) };
  }
  const props = defaultsOf(spec);
  for (const [key, value] of Object.entries(block.props ?? {})) {
    if (key in spec.propSchema && value !== null) props[key] = value;
  }
  const out: Omit<EdBlock, "children"> = { id: block.id, type: block.type, props };
  if (spec.content === "table") out.content = tableIn(block.content);
  else if (spec.content !== "none") out.content = inlineIn(block.content, spec.content === "inline");
  return out;
}

function defaultsOf(spec: BlockSchemaLike[string] | undefined): Obj {
  const out: Obj = {};
  for (const [key, def] of Object.entries(spec?.propSchema ?? {})) {
    if (def.default !== undefined) out[key] = def.default;
  }
  return out;
}

const byPlace = (a: BlockRow, b: BlockRow) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1);

/** A page's stored rows as the editor's tree: by parent, in rank order. */
export function rowsToEditor(rows: BlockRow[], schema: BlockSchemaLike): EdBlock[] {
  const kids = new Map<string, BlockRow[]>();
  for (const row of rows) {
    if (row.deleted_at) continue;
    const list = kids.get(row.parent_id ?? "") ?? [];
    list.push(row);
    kids.set(row.parent_id ?? "", list);
  }
  const build = (parent: string): EdBlock[] =>
    (kids.get(parent) ?? []).sort(byPlace).map((row) => ({ ...toEditor(row, schema), children: build(row.id) }));
  return build("");
}

let counter = 0;

/** A kept version's tree as the editor takes it (read-only: ids only need to be unique). */
export function treeToEditor(tree: BlockTree[], schema: BlockSchemaLike): EdBlock[] {
  return tree.map((b) => ({
    ...toEditor({ id: b.id ?? `v-${++counter}`, type: b.type, props: b.props, content: b.content }, schema),
    children: treeToEditor(b.children ?? [], schema),
  }));
}

// ---- editor -> server ----

function inlineOut(content: unknown): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: Obj[] = [];
  for (const raw of content) {
    if (!isObj(raw)) continue;
    const type = String(raw.type);
    if (type === "text") {
      const node: Obj = { type: "text", text: raw.text };
      const styles = isObj(raw.styles) ? raw.styles : {};
      if (Object.keys(styles).length) node.styles = styles;
      out.push(node);
    } else if (type === "link") {
      out.push({ type: "link", href: raw.href, content: inlineOut(raw.content) });
    } else if (TO_SERVER[type] && isObj(raw.props)) {
      const server = TO_SERVER[type] as string;
      const prop = CHIP_PROP[server] as string;
      out.push({ type: server, props: { [prop]: raw.props[prop] } });
    }
  }
  return out;
}

function tableOut(content: unknown): unknown {
  if (!isObj(content) || !Array.isArray(content.rows)) return { type: "tableContent", rows: [] };
  const out: Obj = {
    type: "tableContent",
    rows: content.rows.map((row) => ({
      cells: (isObj(row) && Array.isArray(row.cells) ? row.cells : []).map((cell) => {
        if (!isObj(cell)) return inlineOut(cell);
        const props: Obj = {};
        for (const [key, value] of Object.entries(isObj(cell.props) ? cell.props : {})) {
          if (value !== undefined && value !== CELL_DEFAULTS[key]) props[key] = value;
        }
        return Object.keys(props).length ? { type: "tableCell", props, content: inlineOut(cell.content) } : inlineOut(cell.content);
      }),
    })),
  };
  if (Array.isArray(content.columnWidths) && content.columnWidths.some((w) => w != null)) out.columnWidths = content.columnWidths;
  if (typeof content.headerRows === "number") out.headerRows = content.headerRows;
  if (typeof content.headerCols === "number") out.headerCols = content.headerCols;
  return out;
}

/** The short form of an editor block: what the server stores for it. */
export function toWire(block: Pick<EdBlock, "type" | "props" | "content">, schema: BlockSchemaLike): Wire {
  const spec = schema[block.type];
  const keep = ALWAYS[block.type] ?? [];
  const props: Obj = {};
  for (const [key, value] of Object.entries(block.props ?? {})) {
    if (value === undefined || value === null) continue;
    if (keep.includes(key) || value !== spec?.propSchema[key]?.default) props[key] = value;
  }
  const wire: Wire = { type: block.type };
  if (Object.keys(props).length) wire.props = props;
  if (spec?.content === "table") wire.content = tableOut(block.content);
  else if (spec && spec.content !== "none") wire.content = inlineOut(block.content);
  return wire;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A string that is equal for two blocks exactly when the server would store the same thing. */
export const signature = (wire: Wire) => stable(wire);

/** A block's text with no markup, for a comment's quote. */
export function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isObj(content) && Array.isArray(content.rows)) {
    return content.rows.map((row) => (isObj(row) && Array.isArray(row.cells) ? row.cells.map((c) => plainText(isObj(c) ? c.content : c)).join(" ") : "")).join(" ");
  }
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const raw of content) {
    if (!isObj(raw)) continue;
    if (typeof raw.text === "string") out += raw.text;
    else if (raw.type === "link") out += plainText(raw.content);
    else if (isObj(raw.props)) out += String(raw.props.handle ? `@${String(raw.props.handle)}` : (raw.props.key ?? ""));
  }
  return out;
}
