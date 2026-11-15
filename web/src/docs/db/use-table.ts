// A database as a view needs it: properties, rows and every cell worked out,
// kept current as rows, properties and members change.

import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useLookup, useLookupEvenIfGone, useMe, useSlug } from "@/data/selectors";
import type { Dict } from "@/data/store";
import { byRank, canSee } from "@/docs/data";
import { type Cells, computeCells, type TableData, type World } from "@/docs/db/compute";
import { pageQuery } from "@/docs/store";
import type { DBProperty, DBView, Doc } from "@/types/docs";

/**
 * Makes sure these databases' properties and views are in the store, each
 * fetched once (they follow the feed from then on). A failure is said in a
 * toast, since what reads the database would otherwise look complete
 * without it, and the fetch is tried again when the live stream comes back.
 * One that is not there, or not for this person, is left.
 */
export function useEnsureDatabases(databaseIds: (string | undefined)[]) {
  const slug = useSlug();
  useQueries({
    queries: [...new Set(databaseIds)]
      .filter((id) => id !== undefined)
      .map((id) => ({
        ...pageQuery(slug, id),
        staleTime: Infinity,
        meta: { failureToast: "db.loadFailed" as const },
      })),
  });
}

/** A database and its rows, out of the live pages. */
function tableOf(docs: Dict<Doc>, props: Dict<DBProperty>, databaseId: string, userId: string): TableData | null {
  const doc = docs[databaseId];
  if (!doc || !canSee(doc, userId)) return null;
  return {
    doc,
    props: Object.values(props)
      .filter((p) => p.database_id === databaseId)
      .sort(byRank),
    rows: Object.values(docs)
      .filter((d) => d.parent_id === databaseId && d.kind === "row")
      .sort(byRank),
  };
}

export interface Database {
  table: TableData;
  cells: Cells;
  world: World;
}

/** The database with every cell computed, or null while it is not in the workspace copy. */
export function useDatabase(databaseId: string | undefined): Database | null {
  const docs = useLookup("docs");
  const props = useLookup("properties");
  // A removed member's handle stays on the rows they made.
  const members = useLookupEvenIfGone("members");
  const me = useMe();

  const out = useMemo(() => {
    if (!databaseId) return null;
    const table = tableOf(docs, props, databaseId, me.user_id);
    if (!table) return null;
    const cache = new Map<string, TableData | null>();
    const world: World = {
      table(id) {
        if (!cache.has(id)) cache.set(id, tableOf(docs, props, id, me.user_id));
        return cache.get(id) ?? null;
      },
      handle(userId) {
        if (!userId) return "";
        const m = members[userId];
        return m ? `@${m.handle}` : "@unknown";
      },
    };
    return { table, world, cells: computeCells(table, world) };
  }, [docs, props, members, me.user_id, databaseId]);

  // Relations and rollups read other databases: fetch their properties once.
  const linked = useMemo(
    () =>
      [
        ...new Set(
          (out?.table.props ?? []).map((p) => (p.type === "relation" ? p.config?.database : undefined)).filter(Boolean),
        ),
      ] as string[],
    [out?.table.props],
  );
  useEnsureDatabases(linked.filter((id) => id !== databaseId));

  return out;
}

/** The properties a view shows, in its own order: the view's `order` first, the rest by rank. */
export function shownProps(props: DBProperty[], view: DBView | undefined, all = false): DBProperty[] {
  const order = view?.config?.order ?? [];
  const hidden = new Set(all ? [] : (view?.config?.hidden ?? []));
  const at = (p: DBProperty) => {
    const i = order.indexOf(p.id);
    return i < 0 ? order.length : i;
  };
  return props.filter((p) => !hidden.has(p.id)).sort((a, b) => at(a) - at(b) || byRank(a, b));
}

/** What every kind of view is given. */
export interface ViewProps {
  db: Database;
  view: DBView;
  /** The rows the view's filters let through, in its sort order. */
  rows: Doc[];
  /** Opens a row in the side peek. */
  onOpen: (rowId: string) => void;
  /** Adds a row with these values (on top of what the view's filters imply) and answers its id. */
  onAdd: (values?: Record<string, unknown>, title?: string) => string;
  /** Shown, not changed: no new rows, no edits, no moves, and the view's own settings stay as they are. */
  readOnly: boolean;
}

/**
 * The values a row made in a view starts with, so it does not vanish behind
 * the view's own filters: "Status is Done" makes new rows Done.
 */
export function defaultsFor(view: DBView | undefined, props: DBProperty[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of view?.config?.filters ?? []) {
    const p = props.find((q) => q.id === f.prop);
    if (!p) continue;
    if (p.type === "checkbox" && (f.op === "checked" || f.op === "unchecked")) out[p.id] = f.op === "checked";
    if (f.op !== "is" || f.value === undefined || f.value === null || f.value === "") continue;
    if (p.type === "multi_select") out[p.id] = [f.value];
    else if (["select", "text", "url", "date"].includes(p.type) && typeof f.value === "string") out[p.id] = f.value;
    else if (p.type === "number" && typeof f.value === "number") out[p.id] = f.value;
  }
  return out;
}
