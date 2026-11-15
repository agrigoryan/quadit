// What a task page shows (filters, grouping, sorting, layout) and how its
// filters and its address follow each other. The address can carry filters
// (a link from the dashboard, a reload): they win over what the page had.
// A filter changed on the page is written into the address at once.

import { useEffect, useEffectEvent, useLayoutEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { today } from "@/lib/time";
import type { Project } from "@/lib/types";
import { type Filters, type QuerySource, sameFilters } from "@/tasks/filters";
import { filtersFromSearch, hasFilters, searchFromFilters } from "@/tasks/url-filters";
import { defaultViewState, useViewState, type ViewState } from "@/tasks/view-state";

interface Options {
  /** Whose state it is: a view's, or a project's. */
  scope: string;
  /** What the page starts from (tasks/saved-view.ts); null for a view it cannot read. */
  saved: ViewState | null;
  tables: QuerySource;
  meId: string;
  project: Project | undefined;
  /** Project pages take their layout from the address (/tasks or /board). */
  routeLayout: "list" | "board" | undefined;
}

export interface PageState {
  state: ViewState;
  setState: (patch: Partial<ViewState>) => void;
  /** A filter changed here: the page takes it at once, and the address follows. */
  setFilters: (filters: Filters) => void;
}

export function usePageState({ scope, saved, tables, meId, project, routeLayout }: Options): PageState {
  const location = useLocation();
  const navigate = useNavigate();
  const readAddress = () => filtersFromSearch(location.search, tables, meId, today(), project?.key);

  const initial = useMemo(() => {
    const start = saved ?? defaultViewState;
    return { ...start, filters: readAddress() ?? start.filters };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- read from the address once for each saved state, not on every change of the address: those arrive through the effect below, and are kept by the page.
  }, [saved]);
  const [stored, setState] = useViewState(scope, initial);
  const state: ViewState = routeLayout ? { ...stored, layout: routeLayout } : stored;

  function writeAddress(filters: Filters) {
    const search = searchFromFilters(filters, tables, project?.id, location.search);
    if (search !== location.search)
      void navigate({ pathname: location.pathname, search }, { replace: true, state: location.state });
  }

  // The address changed from outside (a link, Back, a reload): take its filters. What the page then holds is compared as it stands.
  // An address the page's own filters would write is not from outside, and says less than the page holds: it drops a space
  // just typed at the end of the search text, so taking it would eat the space.
  const takeAddress = useEffectEvent(() => {
    const asked = readAddress();
    const pageWroteIt = searchFromFilters(stored.filters, tables, project?.id, location.search) === location.search;
    if (asked && !pageWroteIt && !sameFilters(asked, stored.filters)) setState({ filters: asked });
  });
  useLayoutEffect(() => takeAddress(), [location.search]);

  // Come back to with a bare address, the page still has its filters: say them in the address again.
  const restoreAddress = useEffectEvent(() => {
    if (!hasFilters(location.search)) writeAddress(stored.filters);
  });
  useEffect(() => restoreAddress(), [scope]);

  function setFilters(filters: Filters) {
    setState({ filters });
    writeAddress(filters);
  }

  return { state, setState, setFilters };
}
