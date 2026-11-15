// What a task page is showing: its filters, grouping, sorting and selection.
// Kept per page (a project, or a saved view) so it survives moving between
// the list and the board, and opening a task.

import { create } from "zustand";
import type { SortBy, ViewDisplay } from "@/lib/types";
import { emptyFilters, type Filters, type Grouping } from "@/tasks/filters";

/** What the columns of a board can stand for. */
export type BoardGrouping = "status" | "assignee" | "label";
export const BOARD_GROUPS: BoardGrouping[] = ["status", "assignee", "label"];
export const LIST_GROUPS: Grouping[] = ["status", "assignee", "label", "epic", "priority", "none"];

export interface ViewState {
  filters: Filters;
  /** How the list is grouped. */
  group: Grouping;
  /** What the board's columns are. */
  boardGroup: BoardGrouping;
  sort: SortBy;
  layout: "list" | "board";
}

export const defaultViewState: ViewState = { filters: emptyFilters, group: "status", boardGroup: "status", sort: "manual", layout: "list" };

/** A saved view's display, as stored: the server's fields, with the list grouped by label and the board's own grouping. */
export type StoredDisplay = Omit<ViewDisplay, "group"> & { group?: Grouping; board_group?: BoardGrouping };

/** The grouping a stored display asks for; anything unknown falls back to status. */
export function readDisplay(display: unknown): { group: Grouping; boardGroup: BoardGrouping; sort: SortBy | undefined } {
  const d = (display && typeof display === "object" ? display : {}) as Record<string, unknown>;
  const group = LIST_GROUPS.find((g) => g === d.group) ?? "status";
  const boardGroup = BOARD_GROUPS.find((g) => g === d.board_group) ?? "status";
  const sort = (["manual", "priority", "updated", "created", "due"] as const).find((v) => v === d.sort);
  return { group, boardGroup, sort };
}

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
