// A task page's filters in its address, so a filtered list can be linked to
// and survives a reload: /games/p/SVA/tasks?waiting_on=none&assignee=none.
// The words are the server's task-query words; a value is a name where the
// name says it (@handle, a status or label name, "none", "me", "outside")
// and an id otherwise. Several values of one filter are joined by commas.

import type { TaskQuery } from "@/lib/types";
import { type Filters, fromQuery, NONE, normalizeQuery, OUTSIDE, type QuerySource } from "@/tasks/filters";

const LISTS = ["assignee", "status", "category", "label", "priority", "epic", "cycle"] as const;
const SINGLE = ["waiting_on", "has_open_decision", "q"] as const;
const WORDS: readonly string[] = [...LISTS, ...SINGLE];

/** True when the address carries any filter. */
export const hasFilters = (search: string): boolean => {
  const params = new URLSearchParams(search);
  return WORDS.some((word) => params.has(word));
};

/**
 * The filters an address asks for, or null when it asks for none. Names are
 * looked up in the project in view when there is one.
 */
export function filtersFromSearch(
  search: string,
  c: QuerySource,
  meId: string,
  today: string,
  projectKey: string | undefined,
): Filters | null {
  const params = new URLSearchParams(search);
  if (!WORDS.some((word) => params.has(word))) return null;
  const raw: Record<string, unknown> = {};
  for (const word of LISTS) {
    const values = params
      .getAll(word)
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length) raw[word] = values;
  }
  for (const word of SINGLE) {
    const value = params.get(word);
    if (value) raw[word] = word === "has_open_decision" ? value !== "0" && value !== "false" : value;
  }
  if (projectKey) raw.project = [projectKey];
  const query: TaskQuery | null = normalizeQuery(raw);
  return query ? fromQuery(query, c, meId, today) : null;
}

/** A name to write in place of an id: only when it is the one row of that name and cannot be misread. */
function nameFor<T extends { id: string; name?: string }>(rows: T[], id: string): string {
  const row = rows.find((r) => r.id === id);
  const name = row?.name ?? "";
  const plain = name !== "" && !/[,&]/.test(name) && name.toLowerCase() !== NONE;
  const only = rows.filter((r) => (r.name ?? "").toLowerCase() === name.toLowerCase()).length === 1;
  return plain && only ? name : id;
}

/**
 * The address query that says these filters, keeping whatever else the
 * address already carried. Empty when nothing is filtered.
 */
export function searchFromFilters(f: Filters, c: QuerySource, projectId: string | undefined, current: string): string {
  const params = new URLSearchParams(current);
  for (const word of WORDS) params.delete(word);
  const inProject = <T extends { project_id?: string }>(rows: T[]) =>
    rows.filter((r) => !projectId || !r.project_id || r.project_id === projectId);
  const member = (id: string) => (id === NONE || id === OUTSIDE ? id : c.members[id] ? `@${c.members[id].handle}` : id);
  const put = (word: string, values: string[]) => values.length > 0 && params.set(word, values.join(","));

  put("assignee", f.assignee.map(member));
  put(
    "status",
    f.status.map((id) => nameFor(inProject(Object.values(c.statuses)), id)),
  );
  put("category", f.category);
  put(
    "label",
    f.label.map((id) => nameFor(inProject(Object.values(c.labels)), id)),
  );
  put("priority", f.priority.map(String));
  put(
    "epic",
    f.epic.map((id) => (id === NONE ? NONE : nameFor(inProject(Object.values(c.epics)), id))),
  );
  put("cycle", f.cycle);
  if (f.waitingOn) params.set("waiting_on", member(f.waitingOn));
  if (f.openDecision) params.set("has_open_decision", "1");
  if (f.text.trim()) params.set("q", f.text.trim());
  const out = params.toString();
  return out ? `?${out}` : "";
}
