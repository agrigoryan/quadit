// Every way the app changes a database's shape: its properties and views.
// Each shows at once and goes out as a named change; a refusal puts things
// back. Row values and rows themselves are pages (docs/actions.ts).

import type { Changes } from "@/types/changes.gen";
import { newId } from "@/lib/ids";
import { send } from "@/data/mutate";
import { rankBetween } from "@/lib/rank";
import type { DBProperty, DBView, Doc, PropConfig, PropertyType, ViewConfig, ViewType } from "@/types/docs";
import { getLookupEvenIfGone, getRows } from "@/data/selectors";

type Fields = Record<string, unknown>;

function lastRank(collection: "properties" | "dbviews", databaseId: string): string {
  let last = "";
  for (const row of Object.values(getLookupEvenIfGone(collection))) {
    if (row.database_id === databaseId && row.rank > last) last = row.rank;
  }
  return rankBetween(last || undefined, undefined);
}

/** A name no live property of the database has yet: "Status", "Status 2". */
export function freeName(databaseId: string, base: string, exceptId?: string): string {
  const taken = new Set(
    getRows("properties")
      .filter((p) => p.database_id === databaseId && p.id !== exceptId)
      .map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

export function createProperty(databaseId: string, name: string, type: PropertyType, config?: PropConfig): string {
  const id = newId();
  const row: DBProperty = {
    id,
    database_id: databaseId,
    name: freeName(databaseId, name.trim() || "Property"),
    type,
    config,
    rank: lastRank("properties", databaseId),
  };
  const args: Changes["property.create"] = { id, database: databaseId, name: row.name, type, rank: row.rank };
  if (config) args.config = config;
  send({ type: "property.create", args }, (tx) => tx.insert("properties", row));
  return id;
}

export function updateProperty(id: string, fields: Partial<Pick<DBProperty, "name" | "type" | "config" | "rank">>) {
  send({ type: "property.update", args: { id, ...fields } }, (tx) => tx.patch("properties", id, fields));
}

export function deleteProperty(id: string) {
  send({ type: "property.delete", args: { id } }, (tx) => tx.patch("properties", id, { deleted_at: Date.now() }));
}

export function createView(databaseId: string, type: ViewType, name: string, config?: ViewConfig): string {
  const id = newId();
  const row: DBView = { id, database_id: databaseId, name, type, config, rank: lastRank("dbviews", databaseId) };
  const args: Changes["dbview.create"] = { id, database: databaseId, name, type, rank: row.rank };
  if (config) args.config = config;
  send({ type: "dbview.create", args }, (tx) => tx.insert("dbviews", row));
  return id;
}

export function updateView(id: string, fields: Partial<Pick<DBView, "name" | "type" | "config" | "rank">>) {
  send({ type: "dbview.update", args: { id, ...fields } }, (tx) => tx.patch("dbviews", id, fields));
}

/** Changes some of a view's settings, keeping the rest. */
export function setViewConfig(view: DBView, patch: Partial<ViewConfig>) {
  const config: ViewConfig = { ...view.config, ...patch };
  for (const key of Object.keys(config) as (keyof ViewConfig)[]) if (config[key] === undefined) delete config[key];
  updateView(view.id, { config });
}

export function deleteView(id: string) {
  send({ type: "dbview.delete", args: { id } }, (tx) => tx.patch("dbviews", id, { deleted_at: Date.now() }));
}

/**
 * Renames an option of a select. One change: the server renames it in the
 * property, in every row that holds it (the trash included) and in the
 * filters of views, and the feed brings all of that back. The property and
 * the rows in the copy are changed at once; a refusal (the name is taken)
 * puts them back and is shown.
 */
export function renameOption(prop: DBProperty, from: string, to: string) {
  const options = prop.config?.options ?? [];
  if (!to || from === to || options.some((o) => o.name === to)) return;
  const patches: [string, Fields][] = [];
  // The server renames it in the trashed rows too.
  for (const row of Object.values(getLookupEvenIfGone("docs"))) {
    if (row.parent_id !== prop.database_id || row.kind !== "row") continue;
    const cur = row.props?.[prop.id];
    let next: unknown;
    if (cur === from) next = to;
    else if (Array.isArray(cur) && cur.includes(from)) next = cur.map((v) => (v === from ? to : v));
    else continue;
    patches.push([row.id, { props: { ...row.props, [prop.id]: next } }]);
  }
  send({ type: "property.update", args: { id: prop.id, rename_option: { from, to } } }, (tx) => {
    tx.patch("properties", prop.id, {
      config: { ...prop.config, options: options.map((o) => (o.name === from ? { ...o, name: to } : o)) },
    });
    for (const [id, fields] of patches) tx.patch("docs", id, fields);
  });
}

/** Moves a row on a board: a new place in the order and, when it changed column, a new value. */
export function moveRow(row: Doc, rank: string, values?: Fields) {
  const args: Changes["doc.update"] = { id: row.id };
  const local: Fields = {};
  if (rank !== row.rank) {
    args.rank = rank;
    local.rank = rank;
  }
  if (values) {
    args.props = values;
    const next: Fields = { ...(row.props ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    local.props = next;
  }
  if (Object.keys(args).length === 1) return;
  send({ type: "doc.update", args }, (tx) => tx.patch("docs", row.id, local));
}
