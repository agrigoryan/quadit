// Every cell of a database, worked out in the browser: stored values as they
// are, and formulas, rollups and the built-in columns from them. A port of
// computed(), rollup(), matchRow() and the sort of internal/server/rows.go,
// so a view shows what `rows?view=` answers.

import { evalFormula, type Value } from "@/docs/db/formula";
import { compareText, formulaText } from "@/docs/db/formula-values";
import type { DBProperty, Doc, RowFilter, RowSort } from "@/lib/types-docs";

/** A database loaded for reading: its columns and its rows, both in order. */
export interface TableData {
  doc: Doc;
  props: DBProperty[];
  rows: Doc[];
}

/** What working out a cell may look up beyond its own database. */
export interface World {
  /** Another database, or null when it is not there (or not visible). */
  table(databaseId: string): TableData | null;
  /** "@handle" for a member; "@unknown" for nobody known; "" for no id. */
  handle(userId: string): string;
  now?: Date;
}

/** Row id → property id → value. A cell that is empty is left out. */
export type Cells = Record<string, Record<string, Value>>;

const lower = (s: string) => s.toLowerCase();
const stored = (row: Doc, propId: string): Value => ((row.props ?? {})[propId] ?? null) as Value;
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function findProp(props: DBProperty[], ref: string | undefined): DBProperty | undefined {
  // The last match wins, as on the server.
  let found: DBProperty | undefined;
  for (const p of props) if (p.id === ref || lower(p.name) === lower(ref ?? "")) found = p;
  return found;
}

function rollup(fn: string | undefined, vals: Value[], related: number): Value {
  const nums = () => {
    const out: number[] = [];
    for (const v of vals) {
      if (typeof v === "number") out.push(v);
      else if (typeof v === "boolean") out.push(v ? 1 : 0);
    }
    return out;
  };
  switch (fn ?? "") {
    case "":
    case "count":
      return related;
    case "values":
      return vals;
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const ns = nums();
      if (ns.length === 0) return null;
      let acc = ns[0] as number;
      for (const n of ns.slice(1)) acc = fn === "min" ? Math.min(acc, n) : fn === "max" ? Math.max(acc, n) : acc + n;
      return fn === "avg" ? acc / ns.length : acc;
    }
    case "percent_checked":
      if (related === 0) return null;
      return (vals.filter((v) => v === true).length * 100) / related;
  }
  return null;
}

export function computeCells(t: TableData, world: World): Cells {
  const byName = new Map<string, DBProperty>();
  for (const p of t.props) byName.set(lower(p.name), p);
  const other = (id: string | undefined) => (id === t.doc.id ? t : id ? world.table(id) : null);

  const titles = (databaseId: string | undefined, ids: Value): Value[] => {
    const rt = other(databaseId);
    const out: Value[] = [];
    if (!rt || !Array.isArray(ids)) return out;
    for (const rid of ids) for (const r of rt.rows) if (r.id === rid) out.push(r.title);
    return out;
  };

  const cell = (row: Doc, p: DBProperty, depth: number): Value => {
    const cfg = p.config ?? {};
    const own = stored(row, p.id);
    switch (p.type) {
      case "created_at":
        return stamp(row.created_at);
      case "updated_at":
        return stamp(row.updated_at);
      case "created_by":
        return world.handle(row.created_by);
      case "member":
        return typeof own === "string" ? world.handle(own) : null;
      case "formula": {
        if (depth > 8) return "#loop";
        const out = evalFormula(cfg.formula ?? "", {
          now: world.now,
          prop: (name) => {
            const key = lower(name);
            if ((key === "title" || key === "name") && !byName.has(key)) return row.title;
            const q = byName.get(key);
            if (!q) return null;
            const v = cell(row, q, depth + 1);
            return q.type === "relation" ? titles(q.config?.database, v) : v;
          },
        });
        return out.error !== undefined ? `#error: ${out.error}` : out.value;
      }
      case "rollup": {
        const rel = findProp(t.props, cfg.relation);
        const rt = other(rel?.config?.database);
        const linked = rel ? stored(row, rel.id) : null;
        const ids = Array.isArray(linked) ? linked : [];
        if (!rt) return null;
        const target = cfg.target ? findProp(rt.props, cfg.target) : undefined;
        const vals: Value[] = [];
        for (const rid of ids) {
          for (const r of rt.rows) {
            if (r.id !== rid) continue;
            if (!target) vals.push(r.title);
            else if (stored(r, target.id) !== null) vals.push(stored(r, target.id));
          }
        }
        return rollup(cfg.fn, vals, ids.length);
      }
    }
    return own;
  };

  const out: Cells = {};
  for (const r of t.rows) {
    const cells: Record<string, Value> = {};
    for (const p of t.props) {
      const v = cell(r, p, 0);
      if (v !== null && v !== undefined) cells[p.id] = v;
    }
    out[r.id] = cells;
  }
  return out;
}

/** Whether a value passes one condition of a view. */
function matchRow(f: Pick<RowFilter, "op" | "value">, v: Value): boolean {
  const text = lower(formulaText(v));
  const want = lower(formulaText((f.value ?? null) as Value));
  switch (f.op as string) {
    case "":
    case "is":
      if (Array.isArray(v)) return v.some((e) => lower(formulaText(e)) === want);
      return text === want;
    case "is_not":
      return !matchRow({ op: "is", value: f.value }, v);
    case "contains":
      return text.includes(want);
    case "empty":
      return text === "";
    case "not_empty":
      return text !== "";
    case "checked":
      return v === true;
    case "unchecked":
      return v !== true;
    case "gt":
    case "lt": {
      if (typeof v !== "number" || typeof f.value !== "number") {
        return f.op === "gt" ? compareText(text, want) > 0 : compareText(text, want) < 0 && text !== "";
      }
      return f.op === "gt" ? v > f.value : v < f.value;
    }
  }
  return true;
}

/** A row's value for a filter or sort: a property by id or name, or the title. */
function valueOf(t: TableData, cells: Cells, row: Doc, ref: string): Value | undefined {
  const p = t.props.find((q) => q.id === ref || lower(q.name) === lower(ref));
  if (lower(ref) === "title" && !p) return row.title;
  if (!p) return undefined;
  return cells[row.id]?.[p.id] ?? null;
}

/** The rows a view shows: its filters applied, then its sorts (the first sort is the main one). */
export function applyView(t: TableData, cells: Cells, filters: RowFilter[] = [], sorts: RowSort[] = []): Doc[] {
  let rows = t.rows;
  for (const f of filters) {
    rows = rows.filter((r) => {
      const v = valueOf(t, cells, r, f.prop);
      // A condition on a property that is gone holds nothing back.
      return v === undefined || matchRow(f, v);
    });
  }
  for (let i = sorts.length - 1; i >= 0; i--) {
    const so = sorts[i] as RowSort;
    const less = (a: Doc, b: Doc) => {
      const va = valueOf(t, cells, a, so.prop) ?? null;
      const vb = valueOf(t, cells, b, so.prop) ?? null;
      const order = compareText(formulaText(va), formulaText(vb));
      const before = typeof va === "number" && typeof vb === "number" ? va < vb : order < 0;
      return so.desc ? !before && order !== 0 : before;
    };
    rows = [...rows].sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
  }
  return rows;
}
