// Which pages are open in the tree. Remembered in this browser.

import { create } from "zustand";
import { keep, readKept } from "@/lib/kept";

const KEY = "quadit.docs.open";

export const useTreeState = create<{ open: Record<string, true>; renaming: string | null }>(() => ({
  open: readKept<Record<string, true>>(KEY, {}),
  renaming: null,
}));

export function setOpen(id: string, open: boolean) {
  useTreeState.setState((s) => {
    if (!!s.open[id] === open) return s;
    const next = { ...s.open };
    if (open) next[id] = true;
    else delete next[id];
    keep(KEY, next);
    return { open: next };
  });
}

export const startRename = (id: string | null) => useTreeState.setState({ renaming: id });
