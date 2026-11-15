// A saved view's stored query and display, read for a task page: what the
// page starts from (or null when the stored query is not one the page can
// read), and what of it names something gone (a deleted label, a person
// removed), which the page leaves out and offers to save the view without.

import { useMemo, useState } from "react";
import { today } from "@/lib/time";
import type { TaskQuery, View } from "@/types/core";
import { fromQuery, goneFromQuery, normalizeQuery, sameFilters, sortFromQuery } from "@/tasks/filters";
import { defaultViewState, readDisplay, type ViewState } from "@/tasks/view-state";
import type { QuerySource } from "@/tasks/properties/property";

export interface SavedView {
  /** The view's query, normalised; null when it cannot be read. */
  query: TaskQuery | null;
  /** The parts of the query that name something gone, or null. */
  gone: Partial<TaskQuery> | null;
  /** What the page starts from: the defaults on a page that is not a view, null for a view the page cannot read. */
  saved: ViewState | null;
}

function readSaved(view: View | undefined, query: TaskQuery | null, tables: QuerySource, meId: string) {
  if (!view) return defaultViewState;
  if (!query) return null;
  try {
    const display = readDisplay(view.display);
    return {
      filters: fromQuery(query, tables, meId, today()),
      group: display.group,
      boardGroup: display.boardGroup,
      sort: display.sort ?? sortFromQuery(query) ?? "manual",
      subtasks: display.subtasks,
      layout: view.layout === "board" ? "board" : "list",
    } satisfies ViewState;
  } catch {
    return null;
  }
}

const sameViewState = (a: ViewState | null, b: ViewState | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    sameFilters(a.filters, b.filters) &&
    a.group === b.group &&
    a.boardGroup === b.boardGroup &&
    a.sort === b.sort &&
    a.subtasks === b.subtasks &&
    a.layout === b.layout);

/**
 * Keeps handing back the same object while each new one reads the same, so
 * that what is worked out from it is not worked out again on every change
 * to the workspace's tables.
 */
function useSameWhileEqual(value: ViewState | null): ViewState | null {
  const [kept, setKept] = useState(value);
  if (sameViewState(kept, value)) return kept;
  setKept(value);
  return value;
}

export function useSavedView(view: View | undefined, tables: QuerySource, meId: string): SavedView {
  // A view written by hand or by an agent may hold a query the page cannot read; it then says so instead of failing.
  const query = useMemo(() => normalizeQuery(view?.query), [view?.query]);
  const isView = view !== undefined;
  const gone = useMemo(
    () => (isView && query ? goneFromQuery(query, tables, meId, today()) : null),
    [isView, query, tables, meId],
  );
  const read = useMemo(() => readSaved(view, query, tables, meId), [view, query, tables, meId]);
  return { query, gone, saved: useSameWhileEqual(read) };
}
