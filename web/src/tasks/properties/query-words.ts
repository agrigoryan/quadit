// How a task query names what it filters by, both ways: a member as
// "@handle", "me", "none" or "outside", a row by its name or its id. A saved
// view or an address written by hand reads the same as one made here.

import type { Dict } from "@/data/store";
import { NONE, OUTSIDE, type QueryContext, type QuerySource } from "@/tasks/properties/property";

const low = (s: string) => s.toLowerCase();

/** The user id a query's word for a member stands for; undefined when it names nobody here. */
export function memberOf(ref: string, { c, meId }: QueryContext): string | undefined {
  if (ref === NONE) return NONE;
  if (ref === OUTSIDE) return OUTSIDE;
  if (ref === "me") return meId;
  const handle = low(ref.replace(/^@/, ""));
  return Object.values(c.members).find((m) => m.user_id === ref || low(m.handle) === handle)?.user_id;
}

/** A member as the address writes it: "@handle"; "none" and "outside" as they are. */
export const memberWord = (id: string, c: QuerySource) =>
  id === NONE || id === OUTSIDE ? id : c.members[id] ? `@${c.members[id].handle}` : id;

/** The ids of the rows a query's word names, by id or by name, in the projects the query is about. */
export const rowsNamed = <T extends { id: string; name: string; project_id?: string }>(
  table: Dict<T>,
  ref: string,
  { inScope }: QueryContext,
): string[] =>
  Object.values(table)
    .filter((row) => (row.id === ref || low(row.name) === low(ref)) && inScope(row.project_id))
    .map((row) => row.id);

/**
 * A row as the address writes it: its name where that is the one row of the
 * name (in the project in view) and cannot be misread, its id otherwise.
 */
export function nameWord<T extends { id: string; name?: string; project_id?: string }>(
  table: Dict<T>,
  id: string,
  projectId: string | undefined,
): string {
  const rows = Object.values(table).filter((r) => !projectId || !r.project_id || r.project_id === projectId);
  const row = rows.find((r) => r.id === id);
  const name = row?.name ?? "";
  const plain = name !== "" && !/[,&]/.test(name) && low(name) !== NONE;
  const only = rows.filter((r) => low(r.name ?? "") === low(name)).length === 1;
  return plain && only ? name : id;
}
