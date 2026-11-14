// What is open on screen: things several parts of the app need to open or
// close (the palette, the create-task dialog, the sidebar on a phone).

import { useEffect } from "react";
import { create } from "zustand";

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

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "collapsed";
  } catch {
    return false;
  }
}

export const useUi = create<UiState>(() => ({
  drawerOpen: false,
  sidebarCollapsed: readCollapsed(),
  paletteOpen: false,
  shortcutsOpen: false,
  newTask: null,
  title: "",
}));

/** Names the page: shown in the top bar and the browser tab. */
export function usePageTitle(title: string) {
  useEffect(() => {
    useUi.setState({ title });
    document.title = title ? `${title} – Quadit` : "Quadit";
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
    try {
      localStorage.setItem(COLLAPSED_KEY, sidebarCollapsed ? "collapsed" : "open");
    } catch {
      // Private mode: the choice lasts for this visit.
    }
  },
};
