// What is open on screen: things several parts of the app need to open or
// close (the palette, the create-task dialog, the sidebar on a phone).

import { useEffect } from "react";
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
 * The names of the pages on screen that name themselves, in the order they
 * did; the last one is shown. Written only by usePageTitle.
 */
const titles: { title: string }[] = [];

function showTitle() {
  const title = titles.at(-1)?.title ?? "";
  useUi.setState({ title });
  document.title = title ? `${title} – Quadit` : "Quadit";
}

/**
 * Names the page: shown in the top bar and the browser tab. When the page
 * goes away its name goes with it, and the page that named itself before
 * (one it was shown inside: Settings around a page that is not there) names
 * the tab again.
 */
export function usePageTitle(title: string) {
  useEffect(() => {
    const mine = { title };
    titles.push(mine);
    showTitle();
    return () => {
      titles.splice(titles.indexOf(mine), 1);
      showTitle();
    };
  }, [title]);
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
