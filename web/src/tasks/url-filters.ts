// A task page's filters in its address, so a filtered list can be linked to
// and survives a reload: /games/p/SVA/tasks?waiting_on=none&assignee=none.
// The words are the server's task-query words; a value is a name where the
// name says it (@handle, a status or label name, "none", "me", "outside")
// and an id otherwise. Several values of one filter are joined by commas.

import type { TaskQuery } from "@/types/core";
import { type Filters, fromQuery, normalizeQuery } from "@/tasks/filters";
import { FILTERS } from "@/tasks/properties";
import type { QuerySource } from "@/tasks/properties/property";

const WORDS: readonly string[] = [...FILTERS.map((p) => p.filter.word), "has_open_decision", "q"];

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
  for (const { filter } of FILTERS) {
    if (filter.holds === "one") {
      const value = params.get(filter.word);
      if (value) raw[filter.word] = value;
      continue;
    }
    const values = params
      .getAll(filter.word)
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length) raw[filter.word] = values;
  }
  const open = params.get("has_open_decision");
  if (open) raw.has_open_decision = open !== "0" && open !== "false";
  const q = params.get("q");
  if (q) raw.q = q;
  if (projectKey) raw.project = [projectKey];
  const query: TaskQuery | null = normalizeQuery(raw);
  return query ? fromQuery(query, c, meId, today) : null;
}

/**
 * The address query that says these filters, keeping whatever else the
 * address already carried. Empty when nothing is filtered.
 */
export function searchFromFilters(f: Filters, c: QuerySource, projectId: string | undefined, current: string): string {
  const params = new URLSearchParams(current);
  for (const word of WORDS) params.delete(word);
  for (const { name, filter } of FILTERS) {
    const values = f[name];
    if (values.length > 0)
      params.set(filter.word, values.map((id) => filter.address?.(id, c, projectId) ?? id).join(","));
  }
  if (f.openDecision) params.set("has_open_decision", "1");
  if (f.text.trim()) params.set("q", f.text.trim());
  const out = params.toString();
  return out ? `?${out}` : "";
}
