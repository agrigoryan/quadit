// Which pages are open in the tree. Remembered in this browser.

import { create } from "zustand";

const KEY = "quadit.docs.open";

function read(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, true>;
  } catch {
    return {};
  }
}

export const useTreeState = create<{ open: Record<string, true>; renaming: string | null }>(() => ({
  open: read(),
  renaming: null,
}));

export function setOpen(id: string, open: boolean) {
  useTreeState.setState((s) => {
    if (!!s.open[id] === open) return s;
    const next = { ...s.open };
    if (open) next[id] = true;
    else delete next[id];
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Private mode: the tree still opens for this visit.
    }
    return { open: next };
  });
}

export const startRename = (id: string | null) => useTreeState.setState({ renaming: id });
