// Every way the app changes a database's shape: its properties and views.
// Each shows at once and goes out as a named change; a refusal puts things
// back. Row values and rows themselves are pages (docs/actions.ts).

import type { Changes } from "@/lib/changes.gen";
import { newId } from "@/lib/ids";
import { mutate, send } from "@/lib/mutate";
import { rankBetween } from "@/lib/rank";
import { getDocs } from "@/docs/data";
import { dropRow, patchRow, putRow, useDocsStore } from "@/docs/store";
import type {
  DBProperty,
  DBView,
  Doc,
  PropConfig,
  PropertyType,
  SelectOption,
  ViewConfig,
  ViewType,
} from "@/lib/types-docs";
import { OPTION_COLORS } from "@/lib/types-docs";

type Fields = Record<string, unknown>;

function lastRank(table: "props" | "views", databaseId: string): string {
  let last = "";
  for (const row of Object.values(useDocsStore.getState()[table])) {
    if (row.database_id === databaseId && row.rank > last) last = row.rank;
  }
  return rankBetween(last || undefined, undefined);
}

/** A name no live property of the database has yet: "Status", "Status 2". */
export function freeName(databaseId: string, base: string, exceptId?: string): string {
  const taken = new Set(
    Object.values(useDocsStore.getState().props)
      .filter((p) => p.database_id === databaseId && !p.deleted_at && p.id !== exceptId)
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
    rank: lastRank("props", databaseId),
  };
  putRow("props", row);
  const args: Changes["property.create"] = { id, database: databaseId, name: row.name, type, rank: row.rank };
  if (config) args.config = config;
  mutate({ type: "property.create", args }).catch(() => dropRow("props", id));
  return id;
}

export function updateProperty(id: string, fields: Partial<Pick<DBProperty, "name" | "type" | "config" | "rank">>) {
  const before = patchRow("props", id, fields);
  if (!before) return;
  mutate({ type: "property.update", args: { id, ...fields } }).catch(() => putRow("props", before as DBProperty));
}

export function deleteProperty(id: string) {
  const before = patchRow("props", id, { deleted_at: Date.now() });
  if (!before) return;
  mutate({ type: "property.delete", args: { id } }).catch(() => putRow("props", before as DBProperty));
}

/** Adds an option to a select property, in the next colour; answers the options as they now are. */
export function addOption(prop: DBProperty, name: string): SelectOption[] {
  const options = prop.config?.options ?? [];
  if (!name || options.some((o) => o.name === name)) return options;
  const next = [...options, { name, color: OPTION_COLORS[options.length % OPTION_COLORS.length] }];
  // Only shown here: the server adds an unknown option itself when the value is written.
  patchRow("props", prop.id, { config: { ...prop.config, options: next } });
  return next;
}

export function createView(databaseId: string, type: ViewType, name: string, config?: ViewConfig): string {
  const id = newId();
  const row: DBView = { id, database_id: databaseId, name, type, config, rank: lastRank("views", databaseId) };
  putRow("views", row);
  const args: Changes["dbview.create"] = { id, database: databaseId, name, type, rank: row.rank };
  if (config) args.config = config;
  mutate({ type: "dbview.create", args }).catch(() => dropRow("views", id));
  return id;
}

export function updateView(id: string, fields: Partial<Pick<DBView, "name" | "type" | "config" | "rank">>) {
  const before = patchRow("views", id, fields);
  if (!before) return;
  mutate({ type: "dbview.update", args: { id, ...fields } }).catch(() => putRow("views", before as DBView));
}

/** Changes some of a view's settings, keeping the rest. */
export function setViewConfig(view: DBView, patch: Partial<ViewConfig>) {
  const config: ViewConfig = { ...view.config, ...patch };
  for (const key of Object.keys(config) as (keyof ViewConfig)[]) if (config[key] === undefined) delete config[key];
  updateView(view.id, { config });
}

export function deleteView(id: string) {
  const before = patchRow("views", id, { deleted_at: Date.now() });
  if (!before) return;
  mutate({ type: "dbview.delete", args: { id } }).catch(() => putRow("views", before as DBView));
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
  const before = patchRow("props", prop.id, {
    config: { ...prop.config, options: options.map((o) => (o.name === from ? { ...o, name: to } : o)) },
  });
  const patches: [string, Fields][] = [];
  for (const row of Object.values(getDocs())) {
    if (row.parent_id !== prop.database_id || row.kind !== "row") continue;
    const cur = row.props?.[prop.id];
    let next: unknown;
    if (cur === from) next = to;
    else if (Array.isArray(cur) && cur.includes(from)) next = cur.map((v) => (v === from ? to : v));
    else continue;
    patches.push([row.id, { props: { ...row.props, [prop.id]: next } }]);
  }
  mutate({ type: "property.update", args: { id: prop.id, rename_option: { from, to } } }, (tx) => {
    for (const [id, fields] of patches) tx.patch("docs", id, fields);
  }).catch(() => {
    if (before) putRow("props", before as DBProperty);
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
