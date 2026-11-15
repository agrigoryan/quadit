// What is open on screen: things several parts of the app need to open or
// close (the palette, the create-task dialog, the sidebar on a phone).

import { useEffect, useState } from "react";
import { create } from "zustand";
import { keep, readKept } from "@/lib/kept";

/** Values a new task starts with when the dialog opens. */
export interface TaskDraft {
  projectId?: string;
  statusId?: string;
  parentId?: string;
  epicId?: string;
  cycleId?: string;
  assigneeId?: string;
}

interface UiState {
  /** The sidebar as a drawer, on a phone. */
  drawerOpen: boolean;
  /** The sidebar folded down to icons, on a desktop. */
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** Not null while the create-task dialog is open. */
  newTask: TaskDraft | null;
  /** The name of the page showing, for the top bar. */
  title: string;
}

const COLLAPSED_KEY = "quadit.sidebar";

export const useUi = create<UiState>(() => ({
  drawerOpen: false,
  sidebarCollapsed: readKept<boolean>(COLLAPSED_KEY, false) === true,
  paletteOpen: false,
  shortcutsOpen: false,
  newTask: null,
  title: "",
}));

/**
 * The names of the pages on screen that name themselves, by the order the
 * pages were drawn in; the last one is shown. Written only by usePageTitle.
 */
const titles: { title: string; order: number }[] = [];

/** Counts the pages drawn, in the order React draws them. Written only by usePageTitle. */
let drawn = 0;

function showTitle() {
  const title = titles.reduce<{ title: string; order: number } | undefined>(
    (last, entry) => (!last || entry.order > last.order ? entry : last),
    undefined,
  )?.title;
  useUi.setState({ title: title ?? "" });
  document.title = title ? `${title} – Quadit` : "Quadit";
}

/**
 * Names the page: shown in the top bar and the browser tab. The page drawn
 * last wins: a page inside another (a page that is not there, inside
 * Settings) over the one around it, also when both come at once, and the
 * later of two side by side. When the page goes away its name goes with it,
 * and the page that named itself before names the tab again.
 */
export function usePageTitle(title: string) {
  // React draws a page before the pages inside it, but runs their effects
  // the other way round, so the order is taken while drawing.
  const [order] = useState(() => ++drawn);
  useEffect(() => {
    const mine = { title, order };
    titles.push(mine);
    showTitle();
    return () => {
      titles.splice(titles.indexOf(mine), 1);
      showTitle();
    };
  }, [title, order]);
}

export const ui = {
  openPalette: () => useUi.setState({ paletteOpen: true }),
  setPalette: (paletteOpen: boolean) => useUi.setState({ paletteOpen }),
  setShortcuts: (shortcutsOpen: boolean) => useUi.setState({ shortcutsOpen }),
  setDrawer: (drawerOpen: boolean) => useUi.setState({ drawerOpen }),
  newTask: (draft: TaskDraft = {}) => useUi.setState({ newTask: draft, paletteOpen: false }),
  closeNewTask: () => useUi.setState({ newTask: null }),
  toggleSidebar: () => {
    const sidebarCollapsed = !useUi.getState().sidebarCollapsed;
    useUi.setState({ sidebarCollapsed });
    keep(COLLAPSED_KEY, sidebarCollapsed);
  },
};
