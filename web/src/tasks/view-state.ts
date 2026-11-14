// What a task page is showing: its filters, grouping, sorting and selection.
// Kept per page (a project, or a saved view) so it survives moving between
// the list and the board, and opening a task.

import { create } from "zustand";
import type { GroupBy, SortBy } from "@/lib/types";
import { emptyFilters, type Filters } from "@/tasks/filters";

export interface ViewState {
  filters: Filters;
  group: GroupBy;
  sort: SortBy;
  layout: "list" | "board";
}

export const defaultViewState: ViewState = { filters: emptyFilters, group: "status", sort: "manual", layout: "list" };

const useStates = create<Record<string, ViewState>>(() => ({}));

/** The state for one page, starting from `initial` the first time it is seen. */
export function useViewState(scope: string, initial: ViewState): [ViewState, (patch: Partial<ViewState>) => void] {
  const state = useStates((s) => s[scope]) ?? initial;
  const set = (patch: Partial<ViewState>) => useStates.setState((s) => ({ [scope]: { ...(s[scope] ?? initial), ...patch } }));
  return [state, set];
}

/** Drops what a page had, so it starts again from what is saved (after a view is updated). */
export function resetViewState(scope: string) {
  useStates.setState((s) => {
    const next = { ...s };
    delete next[scope];
    return next;
  }, true);
}
